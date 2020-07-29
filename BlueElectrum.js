global.net = require('net');
global.tls = require('tls');

const ElectrumClient = require('electrum-client');

const bitcoin = require('bitcoinjs-lib');
const reverse = require('buffer-reverse');

const BigNumber = require('bignumber.js');

//const defaultPeer = { host: 'testnet.hsmiths.com', ssl: '53012' };
const defaultPeer = { host: 'testnet.aranguren.org', ssl: '51002' };
//const defaultPeer = { host: 'blockstream.info', ssl: '993' };
//const defaultPeer = { host: 'electrum1.bluewallet.io', ssl: '443' };
const hardcodedPeers = [
    { host: 'electrum1.bluewallet.io', ssl: '443' },
    { host: 'electrum1.bluewallet.io', ssl: '443' }, // 2x weight
    { host: 'electrum2.bluewallet.io', ssl: '443' },
    { host: 'electrum3.bluewallet.io', ssl: '443' },
    { host: 'electrum3.bluewallet.io', ssl: '443' }, // 2x weight
];

let mainClient = false;
let mainConnected = false;
let wasConnectedAtLeastOnce = false;
let serverName = false;
let disableBatching = false;

const txhashHeightCache = {};

async function connectMain() {
    let usingPeer = defaultPeer; //await getRandomHardcodedPeer();
    /*const savedPeer = await getSavedPeer();
    if (savedPeer && savedPeer.host && (savedPeer.tcp || savedPeer.ssl)) {
        usingPeer = savedPeer;
    }*/

    try {
        console.log('begin connection:', JSON.stringify(usingPeer));
        mainClient = new ElectrumClient(usingPeer.ssl || usingPeer.tcp, usingPeer.host, usingPeer.ssl ? 'tls' : 'tcp');
        mainClient.onError = function (e) {
            mainConnected = false;
        };
        const ver = await mainClient.initElectrum({ client: 'bluewallet', version: '1.4' });
        if (ver && ver[0]) {
            console.log('connected to ', ver);
            serverName = ver[0];
            mainConnected = true;
            wasConnectedAtLeastOnce = true;
            if (ver[0].startsWith('ElectrumPersonalServer') || ver[0].startsWith('electrs')) {
                // TODO: once they release support for batching - disable batching only for lower versions
                disableBatching = true;
                console.log(' disableBatching = true');
            }
            // AsyncStorage.setItem(storageKey, JSON.stringify(peers));  TODO: refactor
        }
    } catch (e) {
        mainConnected = false;
        console.log('bad connection:', JSON.stringify(usingPeer), e);
    }

    if (!mainConnected) {
        console.log('retry');
        mainClient.close && mainClient.close();
        setTimeout(connectMain, 500);
    }
}

module.exports.connectMainClient = async () => {
    await connectMain();
}

module.exports.closeMainClient = async () => {
    await mainClient.close();
}

module.exports.getBalanceByAddress = async function (address) {
    if (!mainClient) throw new Error('Electrum client is not connected');
    const script = bitcoin.address.toOutputScript(address);
    const hash = bitcoin.crypto.sha256(script);
    const reversedHash = Buffer.from(reverse(hash));
    const balance = await mainClient.blockchainScripthash_getBalance(reversedHash.toString('hex'));
    balance.addr = address;
    return balance;
};

module.exports.getConfig = async function () {
    if (!mainClient) throw new Error('Electrum client is not connected');
    return {
        host: mainClient.host,
        port: mainClient.port,
        status: mainClient.status && mainConnected ? 1 : 0,
        serverName,
    };
};

module.exports.getTransactionsByAddress = async function (address, network) {
    if (!mainClient) throw new Error('Electrum client is not connected');
    const script = bitcoin.address.toOutputScript(address, network);
    const hash = bitcoin.crypto.sha256(script);
    const reversedHash = Buffer.from(reverse(hash));
    const history = await mainClient.blockchainScripthash_getHistory(reversedHash.toString('hex'));
    if (history.tx_hash) txhashHeightCache[history.tx_hash] = history.height; // cache tx height
    return history;
};

const splitIntoChunks = function (arr, chunkSize) {
    const groups = [];
    let i;
    for (i = 0; i < arr.length; i += chunkSize) {
        groups.push(arr.slice(i, i + chunkSize));
    }
    return groups;
};

module.exports.multiGetUtxoByAddress = async function (addresses, network, batchsize) {
    batchsize = batchsize || 100;
    if (!mainClient) throw new Error('Electrum client is not connected');
    const ret = {};

    const chunks = splitIntoChunks(addresses, batchsize);
    for (const chunk of chunks) {
        const scripthashes = [];
        const scripthash2addr = {};
        for (const addr of chunk) {
            const script = bitcoin.address.toOutputScript(addr, network);
            const hash = bitcoin.crypto.sha256(script);
            let reversedHash = Buffer.from(reverse(hash));
            reversedHash = reversedHash.toString('hex');
            scripthashes.push(reversedHash);
            scripthash2addr[reversedHash] = addr;
        }

        let results = [];


        // TODO: Electrs supoprts blockchainScripthash_listunspent. (not batch ?)
        if (disableBatching) {
            // ElectrumPersonalServer doesnt support `blockchain.scripthash.listunspent` (not batch ?)
            throw new Error('ElectrumPersonalServer doesnt support `blockchain.scripthash.listunspent`');
        } else {
            results = await mainClient.blockchainScripthash_listunspentBatch(scripthashes);
        }

        for (const utxos of results) {
            ret[scripthash2addr[utxos.param]] = utxos.result;
            for (const utxo of ret[scripthash2addr[utxos.param]]) {
                utxo.address = scripthash2addr[utxos.param];
                utxo.txId = utxo.tx_hash;
                utxo.vout = utxo.tx_pos;
                delete utxo.tx_pos;
                delete utxo.tx_hash;
            }
        }
    }

    return ret;
};

module.exports.estimateFees = async function () {
    const fast = await module.exports.estimateFee(1);
    const medium = await module.exports.estimateFee(18);
    const slow = await module.exports.estimateFee(144);
    return { fast, medium, slow };
};

module.exports.estimateFee = async function (numberOfBlocks) {
    if (!mainClient) throw new Error('Electrum client is not connected');
    numberOfBlocks = numberOfBlocks || 1;
    const coinUnitsPerKilobyte = await mainClient.blockchainEstimatefee(numberOfBlocks);
    //console.log(`${numberOfBlocks}: ${coinUnitsPerKilobyte} coinUnitsPerKilobyte`);
    if (coinUnitsPerKilobyte === -1) return 1;
    return Math.round(new BigNumber(coinUnitsPerKilobyte).dividedBy(1024).multipliedBy(100000000).toNumber());
};

module.exports.multiGetTransactionByTxid = async function (txids, batchsize, verbose) {
    batchsize = batchsize || 45;
    // this value is fine-tuned so althrough wallets in test suite will occasionally
    // throw 'response too large (over 1,000,000 bytes', test suite will pass
    verbose = verbose !== false;
    if (!mainClient) throw new Error('Electrum client is not connected');
    const ret = {};
    txids = [...new Set(txids)]; // deduplicate just for any case

    const chunks = splitIntoChunks(txids, batchsize);
    for (const chunk of chunks) {
        let results = [];

        if (disableBatching) {
            for (const txid of chunk) {
                try {
                    // in case of ElectrumPersonalServer it might not track some transactions (like source transactions for our transactions)
                    // so we wrap it in try-catch
                    let tx = await mainClient.blockchainTransaction_get(txid, verbose);
                    if (typeof tx === 'string' && verbose) {
                        // apparently electrum server (EPS?) didnt recognize VERBOSE parameter, and  sent us plain txhex instead of decoded tx.
                        // lets decode it manually on our end then:
                        tx = txhexToElectrumTransaction(tx);
                        if (txhashHeightCache[txid]) {
                            // got blockheight where this tx was confirmed
                            tx.confirmations = this.estimateCurrentBlockheight() - txhashHeightCache[txid];
                            if (tx.confirmations < 0) {
                                // ugly fix for when estimator lags behind
                                tx.confirmations = 1;
                            }
                            tx.time = this.calculateBlockTime(txhashHeightCache[txid]);
                            tx.blocktime = this.calculateBlockTime(txhashHeightCache[txid]);
                        }
                    }
                    results.push({ result: tx, param: txid });
                } catch (_) { }
            }
        } else {
            results = await mainClient.blockchainTransaction_getBatch(chunk, verbose);
        }

        for (const txdata of results) {
            ret[txdata.param] = txdata.result;
        }
    }

    return ret;
};

module.exports.broadcast = async function (hex) {
    if (!mainClient) throw new Error('Electrum client is not connected');
    try {
        const broadcast = await mainClient.blockchainTransaction_broadcast(hex);
        return broadcast;
    } catch (error) {
        return error;
    }
};

module.exports.broadcastV2 = async function (hex) {
    if (!mainClient) throw new Error('Electrum client is not connected');
    return mainClient.blockchainTransaction_broadcast(hex);
};