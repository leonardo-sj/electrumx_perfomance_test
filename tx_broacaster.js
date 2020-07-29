const BlueElectrum = require('./BlueElectrum');

const broadcastTransaction = async (psbt, currentBitcoinNetwork) => {
    const txHex = psbt.extractTransaction().toHex();
    const data = await BlueElectrum.broadcastV2(txHex);
    return data;
}

module.exports = {
    broadcastTransaction
}