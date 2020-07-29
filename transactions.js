const unchainedBitcoin = require("unchained-bitcoin");
const bitcoinjsLib = require("bitcoinjs-lib");
const axios = require("axios");
const BigNumber = require('bignumber.js');

const BlueElectrum = require('./BlueElectrum');
const { bitcoinsToSatoshis } = require("unchained-bitcoin/lib/utils");

const {
    deriveChildPublicKey,
    blockExplorerAPIURL,
    generateMultisigFromPublicKeys,
} = unchainedBitcoin;

const { payments, networks } = bitcoinjsLib;

const test = () => {
    console.log("teste");
}

const getMultisigDeriationPathForNetwork = (network) => {
    if (network === networks.bitcoin) {
        return "m/48'/0'/0'/2'"
    } else if (network === networks.testnet) {
        return "m/48'/1'/0'/2'"
    } else { // return mainnet by default...this should never run though
        return "m/48'/0'/0'/2'"
    }
}

const getUnchainedNetworkFromBjslibNetwork = (bitcoinJslibNetwork) => {
    if (bitcoinJslibNetwork === networks.bitcoin) {
        return 'mainnet';
    } else {
        return 'testnet';
    }
}

const getChildPubKeysFromXpubs = (xpubs, multisig = true, currentBitcoinNetwork) => {
    const childPubKeys = [];
    for (let i = 0; i < 30; i++) {
        xpubs.forEach((xpub) => {
            const childPubKeysBip32Path = `m/0/${i}`;
            const bip32derivationPath = multisig ? `${getMultisigDeriationPathForNetwork(currentBitcoinNetwork)}/${childPubKeysBip32Path.replace('m/', '')}` : `m/84'/0'/0'/${childPubKeysBip32Path.replace('m/', '')}`;
            childPubKeys.push({
                childPubKey: deriveChildPublicKey(xpub.xpub, childPubKeysBip32Path, getUnchainedNetworkFromBjslibNetwork(currentBitcoinNetwork)),
                bip32derivation: {
                    masterFingerprint: Buffer.from(xpub.parentFingerprint, 'hex'),
                    pubkey: Buffer.from(deriveChildPublicKey(xpub.xpub, childPubKeysBip32Path, getUnchainedNetworkFromBjslibNetwork(currentBitcoinNetwork)), 'hex'),
                    path: bip32derivationPath
                }
            });
        })
    }
    return childPubKeys;
}

const getChildChangePubKeysFromXpubs = (xpubs, multisig = true, currentBitcoinNetwork) => {
    const childChangePubKeys = [];
    for (let i = 0; i < 30; i++) {
        xpubs.forEach((xpub) => {
            const childChangeAddressPubKeysBip32Path = `m/1/${i}`;
            const bip32derivationPath = multisig ? `${getMultisigDeriationPathForNetwork(currentBitcoinNetwork)}/${childChangeAddressPubKeysBip32Path.replace('m/', '')}` : `m/84'/0'/0'/${childChangeAddressPubKeysBip32Path.replace('m/', '')}`;
            childChangePubKeys.push({
                childPubKey: deriveChildPublicKey(xpub.xpub, childChangeAddressPubKeysBip32Path, getUnchainedNetworkFromBjslibNetwork(currentBitcoinNetwork)),
                bip32derivation: {
                    masterFingerprint: Buffer.from(xpub.parentFingerprint, 'hex'),
                    pubkey: Buffer.from(deriveChildPublicKey(xpub.xpub, childChangeAddressPubKeysBip32Path, getUnchainedNetworkFromBjslibNetwork(currentBitcoinNetwork)), 'hex'),
                    path: bip32derivationPath,
                }
            });
        })
    }
    return childChangePubKeys;
}

const getAdressesFromPubKeys = (pubKeys, currentBitcoinNetwork) => {
    return pubKeys.map((childPubKey, _) => {
        const address = payments.p2wpkh({ pubkey: Buffer.from(childPubKey.childPubKey, 'hex'), network: currentBitcoinNetwork });
        address.bip32derivation = [childPubKey.bip32derivation];
        return address;
    });
}


const getTransactionsFromAddresses = async (addresses, currentBitcoinNetwork) => {
    const transactions = [];
    for (let i = 0; i < addresses.length; i++) {
        let txs = await BlueElectrum.getTransactionsByAddress(addresses[i].address, currentBitcoinNetwork);
        txs.forEach((tx) => {
            transactions.push(tx);
        })

    }
    return transactions;
}

const getUnusedAddresses = async (addresses, currentBitcoinNetwork) => {
    const unusedAddresses = [];
    for (let i = 0; i < addresses.length; i++) {
        let txs = await BlueElectrum.getTransactionsByAddress(addresses[i].address, currentBitcoinNetwork);
        if (!txs.length > 0) {
            unusedAddresses.push(addresses[i]);
        }
    }
    return unusedAddresses;
}

const getUtxosForAddresses = async (addresses, currentBitcoinNetwork) => {
    const availableUtxos = [];

    const addrs = addresses.map(a => a.address);

    let utxos = await BlueElectrum.multiGetUtxoByAddress(addrs, currentBitcoinNetwork);
    //console.log(utxos);
    for (let i = 0; i < addresses.length; i++) {
        let addrUtxos = utxos[addresses[i].address];
        for (let z = 0; z < addrUtxos.length; z++) {
            addrUtxos[z].address = addresses[i];
            addrUtxos[z].txid = addrUtxos[z].txId;
            availableUtxos.push(addrUtxos[z]);
            delete addrUtxos[z].txId;
        }
    }

    return availableUtxos;
}

const createAddressMapFromAddressArray = (addressArray) => {
    const addressMap = new Map();
    addressArray.forEach((addr) => {
        addressMap.set(addr.address, addr)
    });
    return addressMap
}

const getFee = async (tx) => {
    const sumOutputs = bitcoinsToSatoshis(tx.vout.reduce((acc, cur) => acc + cur.value, 0));
    const vinTxs = tx.vin.map(t => ({ txid: t.txid, vout: t.vout }));

    let fullTxsVin = await BlueElectrum.multiGetTransactionByTxid(vinTxs.map(t => t.txid));

    const sumInputs = bitcoinsToSatoshis(vinTxs.reduce((acc, cur) => acc + fullTxsVin[cur.txid].vout[cur.vout].value, 0));

    return sumInputs - sumOutputs;
}

const serializeTransactions = async (partialTxs, addresses, changeAddresses) => {

    const changeAddressesMap = createAddressMapFromAddressArray(changeAddresses);
    const addressesMap = createAddressMapFromAddressArray(addresses);

    partialTxs.sort((a, b) => a.height - b.height);

    const txsId = partialTxs.map(t => t.tx_hash);

    let fullTxs = await BlueElectrum.multiGetTransactionByTxid(txsId);

    var sortedTxs = Object.keys(fullTxs).map(key => fullTxs[key]).sort((a, b) => a.blocktime - b.blocktime);

    let currentAccountTotal = BigNumber(0);
    const transactions = new Map();
    for (let i = 0; i < sortedTxs.length; i++) {
        let transactionPushed = false;
        let possibleTransactions = new Map();

        for (let j = 0; j < sortedTxs[i].vout.length; j++) {

            if (!sortedTxs[i].vout[j].value ||
                !sortedTxs[i].vout[j].scriptPubKey ||
                !sortedTxs[i].vout[j].scriptPubKey.addresses)
                continue;

            const scriptpubkeyAddress = sortedTxs[i].vout[j].scriptPubKey.addresses[0];
            const voutValue = bitcoinsToSatoshis(sortedTxs[i].vout[j].value).toNumber();

            if (addressesMap.get(scriptpubkeyAddress)) {
                // received payment
                const transactionWithValues = sortedTxs[i];
                transactionWithValues.value = voutValue;
                transactionWithValues.address = scriptpubkeyAddress;
                transactionWithValues.type = 'received';
                transactionWithValues.totalValue = currentAccountTotal.plus(voutValue).toNumber();
                transactions.set(sortedTxs[i].txid, transactionWithValues);
                transactionPushed = true;
                currentAccountTotal = currentAccountTotal.plus(voutValue)

            } else if (changeAddressesMap.get(scriptpubkeyAddress)) {


            } else {
                // either outgoing payment or sender change address
                if (!transactions.get(sortedTxs[i].txid)) {
                    sortedTxs[i].fee = await getFee(sortedTxs[i])
                    const transactionWithValues = sortedTxs[i];
                    transactionWithValues.value = voutValue;
                    transactionWithValues.address = scriptpubkeyAddress;
                    transactionWithValues.type = 'sent';
                    transactionWithValues.totalValue = currentAccountTotal.minus(voutValue + sortedTxs[i].fee).toNumber();
                    possibleTransactions.set(sortedTxs[i].txid, transactionWithValues)
                }
            }

        }


        if (!transactionPushed) {
            const possibleTransactionsIterator = possibleTransactions.entries();
            for (let i = 0; i < possibleTransactions.size; i++) {
                const possibleTx = possibleTransactionsIterator.next().value;
                currentAccountTotal = currentAccountTotal.minus(possibleTx[1].vout.reduce((accum, vout) => {
                    if (!changeAddressesMap.get(vout.scriptPubKey.addresses[0])) {
                        return accum.plus(bitcoinsToSatoshis(vout.value).toNumber());
                    }
                    return accum;
                }, BigNumber(0))).minus(possibleTx[1].fee);
                transactions.set(possibleTx[0], possibleTx[1]);

            }
        }
    }


    const transactionsIterator = transactions.values();
    const transactionsArray = [];
    for (let i = 0; i < transactions.size; i++) {
        transactionsArray.push(transactionsIterator.next().value);
    }

    transactionsArray.sort((a, b) => b.blocktime - a.blocktime);
    return transactionsArray;
}

const getDataFromXPub = async (currentWallet, currentBitcoinNetwork) => {
    const childPubKeys = getChildPubKeysFromXpubs([currentWallet], false, currentBitcoinNetwork);
    const childChangePubKeys = getChildChangePubKeysFromXpubs([currentWallet], false, currentBitcoinNetwork);

    const addresses = getAdressesFromPubKeys(childPubKeys, currentBitcoinNetwork);
    const changeAddresses = getAdressesFromPubKeys(childChangePubKeys, currentBitcoinNetwork);

    const transactions = await getTransactionsFromAddresses(addresses.concat(changeAddresses), currentBitcoinNetwork);

    const unusedAddresses = await getUnusedAddresses(addresses, currentBitcoinNetwork);

    const unusedChangeAddresses = await getUnusedAddresses(changeAddresses, currentBitcoinNetwork);

    const availableUtxos = await getUtxosForAddresses(addresses.concat(changeAddresses), currentBitcoinNetwork);

    const organizedTransactions = await serializeTransactions(transactions, addresses, changeAddresses);

    return { addresses, changeAddresses, transactions: organizedTransactions, unusedAddresses, unusedChangeAddresses, availableUtxos };
}

module.exports = {
    test,
    getDataFromXPub
}