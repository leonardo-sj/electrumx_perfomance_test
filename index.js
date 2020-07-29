
const bitcoinjsLib = require("bitcoinjs-lib");
const bip39 = require("bip39");
const BigNumber = require('bignumber.js');

const BlueElectrum = require('./BlueElectrum');

//const transactions = require("./transactions")
const transactions = require("./transactions_with_full_scan")
const txBuilder = require("./tx_builder")
const txBroacaster = require("./tx_broacaster.js");

const {
    satoshisToBitcoins,
    blockExplorerURL
} = require("unchained-bitcoin");

const getUnchainedNetworkFromBjslibNetwork = (bitcoinJslibNetwork) => {
    if (bitcoinJslibNetwork === bitcoinjsLib.networks.bitcoin) {
        return 'mainnet';
    } else {
        return 'testnet';
    }
}

const getXKeys = async (mnemonicWords, currentBitcoinNetwork) => {
    const seed = await bip39.mnemonicToSeed(mnemonicWords);
    const root = bitcoinjsLib.bip32.fromSeed(seed, currentBitcoinNetwork);
    const path = "m/84'/0'/0'";
    const child = root.derivePath(path).neutered();
    const xpub = child.toBase58();
    const xprv = root.derivePath(path).toBase58();
    const parentFingerprint = root.fingerprint;
    return { xpub, xprv, parentFingerprint };
}

const testWallet = async (currentBitcoinNetwork) => {
    console.log('start');

    // Before start this script, get a mnemonic and send some coins to some of its addresses
    // fill in the mnemonic below
    const mnemonic = "";
    const keys = await getXKeys(mnemonic, currentBitcoinNetwork);

    await BlueElectrum.connectMainClient();

    console.log("load-wallet");
    console.time("load-wallet");

    let data = await transactions.getDataFromXPub(keys, currentBitcoinNetwork);

    let wallet = { mnemonic, ...keys, ...data, addressType: "P2WSH", quorum: { requiredSigners: 1, totalSigners: 1 } };

    let unusedAddressIndex = 0;

    const receiveAddress = wallet.unusedAddresses[unusedAddressIndex].address;

    wallet.currentBalance = wallet.availableUtxos.reduce((accum, utxo) => accum.plus(utxo.value), BigNumber(0));

    const amountInBitcoins = satoshisToBitcoins(Math.floor(wallet.currentBalance.toNumber() * 0.2));

    const recipientAddress = receiveAddress;

    const psbt = await txBuilder.createTransaction(amountInBitcoins, recipientAddress, wallet, currentBitcoinNetwork);

    const broadcastedTxId = await txBroacaster.broadcastTransaction(psbt);

    const url = blockExplorerURL(`/tx/${broadcastedTxId}`, getUnchainedNetworkFromBjslibNetwork(currentBitcoinNetwork));

    console.log(url);

    await BlueElectrum.closeMainClient();

    console.timeEnd("load-wallet");
    console.log('end');
}

// Test on testnet first
testWallet(bitcoinjsLib.networks.testnet);