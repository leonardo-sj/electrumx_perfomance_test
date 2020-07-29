const BlueElectrum = require('./BlueElectrum');
const BigNumber = require('bignumber.js');

const {
    estimateMultisigTransactionFee,
    bitcoinsToSatoshis
} = require("unchained-bitcoin");

const { bip32, address, Psbt, crypto } = require("bitcoinjs-lib");

const { mnemonicToSeed } = require("bip39");

const getFeeForMultisig = async (addressType, numInputs, numOutputs, requiredSigners, totalSigners) => {
    let fees = await BlueElectrum.estimateFees();
    return estimateMultisigTransactionFee({
        addressType: addressType,
        numInputs: numInputs,
        numOutputs: numOutputs,
        m: requiredSigners,
        n: totalSigners,
        feesPerByteInSatoshis: fees.fast
    })
}

const coinSelection = (amountInSats, availableUtxos) => {
    availableUtxos.sort((a, b) => b.value - a.value); // sort available utxos from largest size to smallest size to minimize inputs
    let currentTotal = BigNumber(0);
    const spendingUtxos = [];
    let index = 0;
    while (currentTotal.isLessThan(amountInSats) && index < availableUtxos.length) {
        currentTotal = currentTotal.plus(availableUtxos[index].value);
        spendingUtxos.push(availableUtxos[index]);
        index++;
    }
    return [spendingUtxos, currentTotal];
}

const createTransactionMapFromTransactionArray = (transactionsArray) => {
    const transactionMap = new Map();
    transactionsArray.forEach((tx) => {
        transactionMap.set(tx.txid, tx)
    });
    return transactionMap
}

const buildPsbt = async (wallet, outputTotal, spendingUtxos, spendingUtxosTotal, amountInBitcoins, recipientAddress, currentBitcoinNetwork) => {

    const transactionMap = createTransactionMapFromTransactionArray(wallet.transactions);

    const psbt = new Psbt({ network: currentBitcoinNetwork });
    psbt.setVersion(2); // These are defaults. This line is not needed.
    psbt.setLocktime(0); // These are defaults. This line is not needed.

    for (let i = 0; i < spendingUtxos.length; i++) {
        const utxo = spendingUtxos[i];


        //const inputAddress = transactionMap.get(utxo.txid).vout[utxo.vout].scriptPubKey.addresses[0];

        let scriptPubKey = Buffer.from(transactionMap.get(utxo.txid).vout[utxo.vout].scriptPubKey.hex, 'hex');

        if (wallet.quorum.requiredSigners > 1) {
            // TODO: Can't test it now
        }
        else {
            psbt.addInput({
                hash: utxo.txid,
                index: utxo.vout,
                sequence: 0xffffffff,
                witnessUtxo: {
                    script: scriptPubKey,
                    value: utxo.value
                },
                bip32Derivation: [{
                    masterFingerprint: Buffer.from(utxo.address.bip32derivation[0].masterFingerprint.buffer, utxo.address.bip32derivation[0].masterFingerprint.byteOffset, utxo.address.bip32derivation[0].masterFingerprint.byteLength),
                    pubkey: Buffer.from(utxo.address.bip32derivation[0].pubkey.buffer, utxo.address.bip32derivation[0].pubkey.byteOffset, utxo.address.bip32derivation[0].pubkey.byteLength),
                    path: utxo.address.bip32derivation[0].path
                }]
            })

        }
    }

    psbt.addOutput({
        script: address.toOutputScript(recipientAddress, currentBitcoinNetwork),
        // address: recipientAddress,
        value: bitcoinsToSatoshis(amountInBitcoins).toNumber(),
    });

    if (spendingUtxosTotal.isGreaterThan(outputTotal)) {

        const changeAddresses = wallet.unusedChangeAddresses[0].address;

        psbt.addOutput({
            script: address.toOutputScript(changeAddresses, currentBitcoinNetwork),
            value: spendingUtxosTotal.minus(outputTotal).toNumber()
        })
    }

    // if only single sign, then sign tx right away
    if (wallet.quorum.requiredSigners === 1) {
        const seed = await mnemonicToSeed(wallet.mnemonic);
        const root = bip32.fromSeed(seed, currentBitcoinNetwork);

        psbt.signAllInputsHD(root);
        psbt.validateSignaturesOfAllInputs();
        psbt.finalizeAllInputs();
    }

    return psbt;
}

const createTransaction = async (amountInBitcoins, recipientAddress, wallet, currentBitcoinNetwork) => {
    const { availableUtxos } = wallet;

    let currentFeeEstimate = await (await getFeeForMultisig(wallet.addressType, 1, 2, wallet.quorum.requiredSigners, wallet.quorum.totalSigners, currentBitcoinNetwork)).integerValue(BigNumber.ROUND_CEIL);
    let outputTotal = BigNumber(bitcoinsToSatoshis(amountInBitcoins)).plus(currentFeeEstimate.toNumber());
    let [spendingUtxos, spendingUtxosTotal] = coinSelection(outputTotal, availableUtxos);

    if (spendingUtxos.length > 1) {
        currentFeeEstimate = await (await getFeeForMultisig(wallet.addressType, spendingUtxos.length, 2, wallet.quorum.requiredSigners, wallet.quorum.totalSigners)).integerValue(BigNumber.ROUND_CEIL);
        outputTotal = BigNumber(bitcoinsToSatoshis(amountInBitcoins)).plus(currentFeeEstimate.toNumber());
        [spendingUtxos, spendingUtxosTotal] = coinSelection(outputTotal, availableUtxos);
    }

    return await buildPsbt(wallet, outputTotal, spendingUtxos, spendingUtxosTotal, amountInBitcoins, recipientAddress, currentBitcoinNetwork);
}

module.exports = {
    createTransaction
}