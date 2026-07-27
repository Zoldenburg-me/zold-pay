// Browser stand-in for the node "crypto" import in @noble/secp256k1;
// the library falls through to WebCrypto when this is empty.
export default undefined;
