const ffmpegPath = require('ffmpeg-static');
const { spawn } = require('node:child_process');
const ews = require('express-ws');
const ps = require('ps-node');
const fs = require('node:fs');

class InboundStreamWrapper {
    constructor() {
        this.clients = 0;
    }

    start({ url, additionalFlags = [], transport, windowsHide = true }) {
        if (this.verbose) console.log('[rtsp-relay] Creating brand new stream image');

        // validate config
        const txpConfigInvalid = additionalFlags.indexOf('-rtsp_transport');
        if (~txpConfigInvalid) {
            const val = additionalFlags[0o1 + txpConfigInvalid];
            console.warn(
                `[rtsp-relay] (!) Do not specify -rtsp_transport=${val} in additionalFlags, use the option \`transport: '${val}'\``,
            );
        }

        this.stream = spawn(
            'ffmpeg',
            [
                ...(transport ? ['-rtsp_transport', transport] : []),
                '-i',
                url,
                '-f',
                'image2',
                '-update', '1',
                ...additionalFlags,
                '-'
            ],
            { detached: false, windowsHide },
        );
        this.stream.stderr.on('data', () => {});
        this.stream.stderr.on('error', (e) => console.log('err:error', e));
        this.stream.stdout.on('error', (e) => console.log('out:error', e));
        this.stream.on('error', (err) => {
            if (this.verbose) {
                console.warn(`[rtsp-relay] Internal Error: ${err.message}`);
            }
        });

        this.stream.on('exit', (_code, signal) => {
            if (signal !== 'SIGTERM') {
                if (this.verbose) {
                    console.warn(
                        '[rtsp-relay] Stream died - will recreate when the next client connects',
                    );
                }
                this.stream = null;
            }
        });
    }

    /** @param {Options} options */
    get(options) {
        this.verbose = options.verbose;
        this.clients += 1;
        if (!this.stream) this.start(options);
        return /** @type {Stream} */ (this.stream);
    }

    decrement() {
        this.clients -= 1;
        return this.clients;
    }

    /** @param {number} clientsLeft */
    kill(clientsLeft) {
        if (!this.stream) return; // the stream is currently dead
        if (!clientsLeft) {
            if (this.verbose) {
                console.log('[rtsp-relay] no clients left; destroying stream');
            }
            this.stream.kill('SIGTERM');
            this.stream = null;
            // next time it is requested it will be recreated
            return;
        }

        if (this.verbose) {
            console.log(
                '[rtsp-relay] there are still some clients so not destroying stream',
            );
        }
    }
}

/** @type {ReturnType<ews>} */
let wsInstance;

/**
 * @param {Application} app the express application
 * @param {import("http").Server | import("https").Server} [server] optional - if you use HTTPS you will need to pass in the server
 */
module.exports = (app, server) => {
    if (!wsInstance) wsInstance = ews(app, server);
    const wsServer = wsInstance.getWss();

    /**
     * This map stores all the streams in existance, keyed by the URL.
     * This means we only ever create one InboundStream per URL.
     * @type {{ [url: string]: InboundStreamWrapper }}
     */
    const Inbound = {};

    const CacheImage = {};

    return {
        /**
         * You must include a script tag in the HTML to import this script
         *
         * Alternatively, if you have set up a build process for front-end
         * code, you can import it instead:
         * ```js
         * import { loadPlayer } from "rtsp-relay/browser";
         * ```
         */
        killAll() {
            ps.lookup({ command: 'ffmpeg' }, (err, list) => {
                if (err) throw err;
                list
                    .filter((p) => p.arguments.includes('mpeg1video'))
                    .forEach(({ pid }) => ps.kill(pid));
            });
        },

        /** @param {Options} props */
        proxy({ url, verbose, name, ...options }) {
            if (!url) throw new Error('URL to rtsp stream is required');

            if (!Inbound[url]) Inbound[url] = new InboundStreamWrapper();
            if (!CacheImage[url]) {
                CacheImage[url] = null
            }

            /** @param {WebSocket} ws */
            function handler(ws) {
                // these should be detected from the source stream
                // const [width, height] = [0x0, 0x0];
                //
                // const streamHeader = Buffer.alloc(0x8);
                // streamHeader.write('Video loading');
                // streamHeader.writeUInt16BE(width, 0x4);
                // streamHeader.writeUInt16BE(height, 0x6);
                //
                // const str = fs.readFileSync('logo250x135.gif');
                // ws.send(str, { binary: true });

                if (verbose) console.log('[rtsp-relay] New WebSocket Connection');

                const streamIn = Inbound[url].get({ url, verbose, ...options });

                let buffs = [];
                let offset,
                offset2;

                /** @param {Buffer} chunk */
                function onData(data) {
                    if (ws.readyState !== ws.OPEN) return;

                    //The image can be composed of one or multiple chunk when receiving stream data.
                    //Store all bytes into an array until we meet flag "FF D9" that mean it's the end of the image then we can send all data in order to display the full image.
                    if (data.length >1) {
                        buffs.push(data);

                        offset      = data[data.length-2].toString(16);
                        offset2     = data[data.length-1].toString(16);

                        if(offset == "ff" && offset2 == "d9") {
                            const image = Buffer.concat(buffs);
                            ws.send(image);
                            CacheImage[url] = image;
                            // self.emit('data', Buffer.concat(self.buffs));
                            buffs = [];
                        }
                    }
                }

                ws.on('close', () => {
                    const c = Inbound[url].decrement();
                    if (verbose) {
                        console.log(`[rtsp-relay] WebSocket Disconnected ${c} left`);
                    }

                    if (!c && CacheImage[url]) {
                        const path = __dirname + '/../public/images/' + name;

                        fs.mkdirSync(path, { recursive: true });

                        fs.writeFileSync(path + '/thumb.jpg', CacheImage[url]);
                    }
                    Inbound[url].kill(c);
                    streamIn.stdout.off('data', onData);
                });

                streamIn.stdout.on('data', onData);
            }
            return handler;
        },
    };
};
