import "./App.css";
import React from 'react';
import * as nearlib from 'near-api-js';
import * as nacl from "tweetnacl";
import WebRTC from './rtc.js';

const ContractName = 'dev-1615731045305-7376841';
const MaxTimeForResponse = 60 * 1000;
const MinAccountIdLen = 2;
const MaxAccountIdLen = 64;
const ValidAccountRe = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
const MediaConstraints = {
    audio: true,
    video: true
};

const gas = 300000000000000;

class App extends React.Component {
    constructor(props) {
        super(props);

        this.state = {
            connected: false,
            signedIn: false,
            calling: false,
            accountId: null,
            receiverId: "",
            receiversKey: null,
            accountLoading: false,
            callConnected: false,
            type: "creator",

            tokens: {},
            transfer_receiver_id: "",
            transfer_token_id: 0,
            mint_token_id: "",
            mint_metadata: "",

            initial_caller: "",
            initial_receiver: "",
        };

        this._parseEncryptionKey()
        this._initNear().then(() => {
            this.setState({
                connected: true,
                signedIn: !!this._accountId,
                accountId: this._accountId,
            })
        })

        this.localVideoRef = React.createRef();
        this.remoteVideoRef = React.createRef();
    }

    /**
     read private key from local storage
     - if found, recreate the related key pair
     - if not found, create a new key pair and save it to local storage
     */
    _parseEncryptionKey() {
        const keyKey = "enc_key:";
        let key = localStorage.getItem(keyKey);
        if (key) {
            const buf = Buffer.from(key, 'base64');
            if (buf.length !== nacl.box.secretKeyLength) {
                throw new Error("Given secret key has wrong length");
            }
            key = nacl.box.keyPair.fromSecretKey(buf);
        } else {
            key = new nacl.box.keyPair();
            localStorage.setItem(keyKey, Buffer.from(key.secretKey).toString('base64'));
        }
        this._key = key;
    }

    async _updateEncryptionPublicKey() {
        const key = Buffer.from(this._key.publicKey).toString('base64');

        const currentKey = await this._contract.get_key({account_id: this._accountId});
        if (currentKey !== key) {
            console.log(`Updating public encryption key to ${key}`);
            await this._contract.set_key({key});
        } else {
            console.log(`Current public encryption key is up to date: ${key}`);
        }
    }

    async _initNear() {
        const nearConfig = {
            networkId: 'default',
            nodeUrl: 'https://rpc.testnet.near.org',
            contractName: ContractName,
            walletUrl: 'https://wallet.testnet.near.org',
        };
        const keyStore = new nearlib.keyStores.BrowserLocalStorageKeyStore();
        const near = await nearlib.connect(Object.assign({deps: {keyStore}}, nearConfig));
        this._keyStore = keyStore;
        this._nearConfig = nearConfig;
        this._near = near;

        this._walletConnection = new nearlib.WalletConnection(near, "webrtc-chat");
        this._accountId = this._walletConnection.getAccountId();

        if (!!this._accountId) {
            this._account = this._walletConnection.account();
            this._contract = new nearlib.Contract(this._account, ContractName, {
                viewMethods: ['get_tokens',
                    'get_key', 'get_key_by_token_owner', 'get_key_by_token_creator',
                    'get_request_by_token', 'get_response_by_token'],
                changeMethods: ['set_key', 'request_by_token', 'respond_by_token', 'sale_token', 'mint'],
            });
            await this._updateEncryptionPublicKey();

            this.OnChatLoad();
        }
    }

    setType(value) {
        this.setState({
            type: value,
        })
    }

    handleChange(key, value) {
        const stateChange = {
            [key]: value,
        };
        if (key === 'receiverId') {
            value = value.toLowerCase().replace(/[^a-z0-9\-_.]/, '');
            stateChange[key] = value;
            stateChange.receiversKey = null;
            if (this.isValidAccount(value)) {
                stateChange.accountLoading = true;

                console.log(this.state.type);

                if (this.state.type === "owner") {
                    this._contract.get_key_by_token_creator({token_id: value}).then((receiversKey) => {
                        if (this.state.receiverId === value) {
                            this.setState({
                                accountLoading: false,
                                receiversKey,
                            })
                        }
                    }).catch((e) => {
                        if (this.state.receiverId === value) {
                            this.setState({
                                accountLoading: false,
                            })
                        }
                    })
                } else if (this.state.type === "creator") {
                    this._contract.get_key_by_token_owner({token_id: value}).then((receiversKey) => {
                        console.log(receiversKey);

                        if (this.state.receiverId === value) {
                            this.setState({
                                accountLoading: false,
                                receiversKey,
                            })
                        }
                    }).catch((e) => {
                        if (this.state.receiverId === value) {
                            this.setState({
                                accountLoading: false,
                            })
                        }
                    })
                } else { // default
                    this._contract.get_key({account_id: value}).then((receiversKey) => {
                        if (this.state.receiverId === value) {
                            this.setState({
                                accountLoading: false,
                                receiversKey,
                            })
                        }
                    }).catch((e) => {
                        if (this.state.receiverId === value) {
                            this.setState({
                                accountLoading: false,
                            })
                        }
                    })
                }


            }
        }
        this.setState(stateChange);
    }

    isValidAccount(accountId) {
        return true;/*
    return accountId.length >= MinAccountIdLen &&
        accountId.length <= MaxAccountIdLen &&
        accountId.match(ValidAccountRe);
        */
    }

    receiverClass() {
        if (!this.state.receiverId || (this.isValidAccount(this.state.receiverId) && this.state.accountLoading)) {
            return "form-control form-control-large";
        } else if (this.isValidAccount(this.state.receiverId) && this.state.receiversKey) {
            return "form-control form-control-large is-valid";
        } else {
            return "form-control form-control-large is-invalid";
        }
    }

    async requestSignIn() {
        const appTitle = 'NEAR Chat';
        await this._walletConnection.requestSignIn(
            ContractName,
            appTitle
        )
    }

    /**
     unbox encrypted messages with our secret key
     @param {string} msg64 encrypted message encoded as Base64
     @param {Uint8Array} theirPublicKey the public key to use to verify the message
     @return {string} decoded contents of the box
     */
    decryptBox(msg64, theirPublicKey64) {
        const theirPublicKey = Buffer.from(theirPublicKey64, 'base64');
        if (theirPublicKey.length !== nacl.box.publicKeyLength) {
            throw new Error("Given encryption public key is invalid.");
        }
        const buf = Buffer.from(msg64, 'base64');
        const nonce = new Uint8Array(nacl.box.nonceLength);
        buf.copy(nonce, 0, 0, nonce.length);
        const box = new Uint8Array(buf.length - nacl.box.nonceLength);
        buf.copy(box, 0, nonce.length);
        const decodedBuf = nacl.box.open(box, nonce, theirPublicKey, this._key.secretKey);
        return Buffer.from(decodedBuf).toString()
    }

    /**
     box an unencrypted message with their public key and sign it with our secret key
     @param {string} str the message to wrap in a box
     @param {Uint8Array} theirPublicKey the public key to use to encrypt the message
     @returns {string} base64 encoded box of incoming message
     */
    encryptBox(str, theirPublicKey64) {
        const theirPublicKey = Buffer.from(theirPublicKey64, 'base64');
        if (theirPublicKey.length !== nacl.box.publicKeyLength) {
            throw new Error("Given encryption public key is invalid.");
        }
        const buf = Buffer.from(str);
        const nonce = nacl.randomBytes(nacl.box.nonceLength);
        const box = nacl.box(buf, nonce, theirPublicKey, this._key.secretKey);

        const fullBuf = new Uint8Array(box.length + nacl.box.nonceLength);
        fullBuf.set(nonce);
        fullBuf.set(box, nacl.box.nonceLength);
        return Buffer.from(fullBuf).toString('base64')
    }

    async initCall() {
        const receiverId = this.state.receiverId;
        const receiversKey = this.state.receiversKey;
        this.setState({
            calling: true,
        });

        this.webrtc = new WebRTC();
        this.webrtc.addOnTrackListener((e) => {
            console.log("got remote streams", e);
            if (this.remoteVideoRef.current.srcObject !== e.streams[0]) {
                this.remoteVideoRef.current.srcObject = e.streams[0];
                this.remoteVideoRef.current.play();
            }
        });

        const stream = await navigator.mediaDevices.getUserMedia(MediaConstraints);
        this.localVideoRef.current.srcObject = stream;
        this.localVideoRef.current.play();

        this.webrtc.addStream(stream);

        console.log(this.state.type);

        if (this.state.type === "owner") {
            try {
                console.log(`get_request_by_token  token_id: ${receiverId}        to_account_id: ${this._accountId}`);
                // First check if they called us first
                const theirRequestEncoded = await this._contract.get_request_by_token({
                    token_id: receiverId,
                    to_account_id: this._accountId,
                });

                if (theirRequestEncoded) {
                    // decoding
                    const theirRequest = JSON.parse(this.decryptBox(theirRequestEncoded, receiversKey));
                    console.log(theirRequest);
                    if (theirRequest) {
                        const theirTime = theirRequest.time || 0;
                        if (theirTime + MaxTimeForResponse > new Date().getTime()) {
                            const offer = theirRequest.offer;
                            console.log("Remote offer: ", offer);
                            const answer = await this.webrtc.createAnswer(offer);
                            console.log("Local answer: ", answer);
                            // Publishing answer
                            const response = this.encryptBox(JSON.stringify({
                                answer,
                                time: new Date().getTime(),
                            }), receiversKey);

                            console.log(`respond_by_token  token_id: ${receiverId}`);

                            await this._contract.respond_by_token({
                                token_id: receiverId,
                                response,
                            });
                            this.setState({
                                callConnected: true,
                            })
                            return;
                        }
                    }
                }
            } catch (e) {
                console.log("Failed to parse request", e);
            }
        } else if (this.state.type === "creator") {
            // Sending a new request
            const offer = await this.webrtc.createOffer();
            console.log("Local offer: ", offer);
            const requestTime = new Date().getTime();
            const request = this.encryptBox(JSON.stringify({
                offer,
                time: requestTime,
            }), receiversKey);

            console.log("request");
            console.log(request);

            console.log(`request_by_token  token_id: ${receiverId}`);

            await this._contract.request_by_token({
                token_id: receiverId,
                request,
            });

            this.setState({
                awaitingResponse: true,
            })


            // Sent request, now need to check for the answer.
            while (this.state.calling && requestTime + MaxTimeForResponse > new Date().getTime()) {
                try {
                    console.log(`get_response_by_token  token_id: ${receiverId}  from_account_id: ${this._accountId}`);

                    const theirResponseEncoded = await this._contract.get_response_by_token({
                        from_account_id: this._accountId,
                        token_id: receiverId,
                    });

                    if (theirResponseEncoded) {
                        // decoding
                        const theirResponse = JSON.parse(this.decryptBox(theirResponseEncoded, receiversKey));
                        console.log(theirResponse);
                        if (theirResponse) {
                            const answer = theirResponse.answer;
                            console.log("Remote answer: ", answer);
                            await this.webrtc.onAnswer(answer);
                            this.setState({
                                callConnected: true,
                                awaitingResponse: false,
                            })
                            return;
                        }
                    }
                } catch (e) {
                    console.log("Failed to get response", e);
                    this.setState({
                        awaitingResponse: false,
                        calling: false,
                    })
                    return;
                }
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }

        this.setState({
            awaitingResponse: false,
            calling: false,
        })

        this.hangUp();
    }

    hangUp() {
        if (this.state.calling) {
            this.webrtc.close();
            this.webrtc = null;
            this.localVideoRef.current.pause();
            this.setState({
                calling: false,
            })
        }
    }

    async localCall() {
        const local = new WebRTC();
        const remote = new WebRTC();

        local.addOnTrackListener((e) => console.log("local", e));
        remote.addOnTrackListener((e) => {
            console.log("remote", e);
            if (this.remoteVideoRef.current.srcObject !== e.streams[0]) {
                this.remoteVideoRef.current.srcObject = e.streams[0];
                this.remoteVideoRef.current.play();
            }
        });

        const stream = await navigator.mediaDevices.getUserMedia(MediaConstraints);
        this.localVideoRef.current.srcObject = stream;
        this.localVideoRef.current.play();

        local.addStream(stream);

        const offer = await local.createOffer();
        console.log(offer);
        const answer = await remote.createAnswer(offer);
        console.log(answer);

        await local.onAnswer(answer);
    }

    OnChatLoad() {
        // setInterval(() => {
        this._contract.get_tokens().then((tokens) => {
            this.setState({tokens: tokens})

            if (Object.keys(this.state.tokens).length)
                this.state.transfer_token_id = Object.keys(this.state.tokens)[0];
        })
        //}, 1000);

    }


    render() {
        const AllNFTs = () => {
            return <ol>
                {Object.keys(this.state.tokens).map((token) => {
                    return <li key={token}>{token}: {this.state.tokens[token].owner_id}</li>;
                })}
            </ol>
        };

        const TransferNft = () => {
            return Object.keys(this.state.tokens).length
                ? <div>
                    <select id="type" onChange={(e) => this.state.transfer_token_id = e.target.value}
                            value={this.state.transfer_token_id}>
                        {Object.keys(this.state.tokens).map((token) => {
                            return <option key={token} value={token}>{token}</option>;
                        })}
                    </select>
                    <div>
                        Receiver Account <input type="text"
                                                defaultValue={this.state.transfer_receiver_id}
                                                autoComplete="off"
                                                onChange={(e) => this.state.transfer_receiver_id = e.target.value}
                    />
                    </div>
                    <div>
                        <button
                            onClick={async event => {
                                this._contract.sale_token(
                                    {
                                        token_id: this.state.transfer_token_id,
                                        receiver_id: this.state.transfer_receiver_id
                                    }, gas, 1
                                )
                            }}>
                            Send
                        </button>
                    </div>
                </div>
                : <div>Tokens not found</div>;
        }

        const MintNft = () => {
            return <div>
                <div>
                    Token ID <input type="text"
                                    defaultValue={this.state.mint_token_id}
                                    autoComplete="off"
                                    onChange={(e) => this.state.mint_token_id = e.target.value}
                />
                </div>
                <div>
                    Metadata <input type="text"
                                    defaultValue={this.state.mint_metadata}
                                    autoComplete="off"
                                    onChange={(e) => this.state.mint_metadata = e.target.value}
                />
                </div>
                <div>
                    <button
                        onClick={async event => {
                            this._contract.mint(
                                {
                                    token_id: this.state.mint_token_id,
                                    metadata: this.state.mint_metadata
                                }, gas, "1000000000000000000000000"
                            )
                        }}>
                        Mint
                    </button>
                </div>
            </div>

        }

        const content = !this.state.connected ? (
            <div>Connecting... <span className="spinner-grow spinner-grow-sm" role="status" aria-hidden="true"></span>
            </div>
        ) : (this.state.signedIn ? (
            <div>
                <div>
                    Hello, {this.state.accountId}. Your role:
                    <select id="type" onChange={(e) => this.setType(e.target.value)} value={this.type}>
                        <option value="creator">NFT Creator</option>
                        <option value="owner">NFT Owner</option>
                    </select>
                </div>
                <div className="form-group">
                    <label className="sr-only" htmlFor="toAccountId">Video Call</label>
                    <div className="input-group">
                        <div className="input-group-prepend">
                            <div className="input-group-text">NFT:</div>
                        </div>
                        <input type="text"
                               className={this.receiverClass()}
                               id="toAccountId"
                               placeholder="Token ID"
                               disabled={this.state.calling}
                               value={this.state.receiverId}
                               onChange={(e) => this.handleChange('receiverId', e.target.value)}
                        />
                    </div>
                </div>
                <div className="form-group">
                    <div>
                        <button
                            className="btn btn-success"
                            disabled={this.state.calling || !this.isValidAccount(this.state.receiverId) || !this.state.receiversKey}
                            onClick={() => this.initCall()}>Initiate Video Call
                        </button>
                        <span> </span>
                        <button
                            className="btn btn-danger"
                            disabled={!this.state.calling}
                            onClick={() => this.hangUp()}>Hang up
                        </button>
                    </div>
                </div>
                <hr/>
                <video className="local-video" ref={this.localVideoRef} playsInline muted></video>
                <video className="remote-video" ref={this.remoteVideoRef} playsInline></video>

                <hr/>
                <div style={{padding: "20px"}}>
                    <h4>Underground</h4>

                    <h5>Mint NFT</h5>
                    <MintNft/>
                    <hr />
                    <h5>Transfer NFT</h5>
                    <TransferNft/>
                    <hr />
                    <h5>All NFTs</h5>
                    <AllNFTs/>
                    <hr />

                    <button
                        onClick={async event => {
                            event.preventDefault();
                            this.OnChatLoad()
                        }}>
                        Reload
                    </button>
                </div>
            </div>
        ) : (
            <div>
                <button
                    className="btn btn-primary"
                    onClick={() => this.requestSignIn()}>Log in with NEAR Wallet
                </button>
            </div>
        ));
        return (
            <div>
                <h1>NEAR Chat</h1>
                {content}
            </div>
        );
    }
}

export default App;
