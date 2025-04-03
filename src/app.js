require('dotenv').config();
const express = require('express');
const app = express();
const bodyParser = require('body-parser')
const fs = require('node:fs');
const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('db/db.sqlite3');
// parse application/json
app.use(bodyParser.json());

const SECRET_KEY = process.env.RTSP_SECRET_KEY;
const RTSP_DOMAIN = process.env.RTSP_DOMAIN;

db.serialize(() => {
    // db.run(`DROP TABLE IF EXISTS rtsp_link`);
    db.run(`CREATE TABLE IF NOT EXISTS rtsp_link
    (
        name VARCHAR
            (
        255
            ) NOT NULL UNIQUE,
        link VARCHAR
            (
                255
            ) NOT NULL
        );
    `);
});

const {proxy} = require('./rtsp-relay')(app);
const {proxy:proxyImage} = require('./rtsp-image')(app);

app.ws('/api/image', (ws, req) => {
    const additionalFlags = [
        '-r',
        '1',
    ];

    db.get("SELECT rowid AS id, name, link FROM rtsp_link WHERE name =?", [req.query.name], (err, row) => {
        if (row) {
            proxyImage({
                url: row.link,
                name: row.name,
                // if your RTSP stream need credentials, include them in the URL as above
                verbose: true,
                additionalFlags,
                transport: 'tcp',
            })(ws);
        } else {
            setTimeout(() => {
                ws.send('error: no such stream');
            }, 3000);
        }
    });
});

// the endpoint our RTSP uses
app.ws('/api/stream', (ws, req) => {
    let w = req.query.w && Number(req.query.w);
    let h = req.query.h && Number(req.query.h);
    const additionalFlags = [];

    // if (w && h) {
    //     additionalFlags.push('-s', `${w}x${h}`);
    // }
    // if (w &&!h) {
    //     h = Math.ceil(w / (16 / 9))
    //     additionalFlags.push('-s', `${w}x${h}`);
    // }

    additionalFlags.push('-s', '854x480');
    additionalFlags.push('-b:a', '128k');

    db.get("SELECT rowid AS id, name, link FROM rtsp_link WHERE name =?", [req.query.name], (err, row) => {
        if (row) {
            proxy({
                url: row.link,
                // if your RTSP stream need credentials, include them in the URL as above
                verbose: true,
                additionalFlags,
            })(ws);
        } else {
            setTimeout(() => {
                ws.send('error: no such stream');
            }, 3000);
        }
    });
});

app.use(express.static('public'));

app.get('/', (req, res) =>
    res.json({status: '200', message: 'success'}),
);
app.get('/video', (req, res) => {
    let html = fs.readFileSync(__dirname + '/../stub/video.stub', 'utf8');

    const link_stream = RTSP_DOMAIN + '/api/stream?name=' + req.query.name;

    html = html.replace(/url_websocket/g, link_stream);
    res.send(html);
});
app.get('/image', (req, res) => {
    let html = fs.readFileSync(__dirname + '/../stub/image.stub', 'utf8');

    const link_stream = RTSP_DOMAIN + '/api/image?name=' + req.query.name;

    html = html.replace(/url_websocket/g, link_stream);

    const url_image_thumbnail = `/public/images/${req.query.name}/thumb.jpg`;

    html = html.replace(/url_image_thumbnail/g, url_image_thumbnail);
    res.send(html);
});

app.get('/api/rtsp/list', (req, res) => {
    const data = [];
    db.each("SELECT rowid AS id, name, link FROM rtsp_link", (err, row) => {
        data.push({
            id: row.id,
            name: row.name,
            link: row.link,
        });
    }, () => {
        res.json({status: '200', message: 'success', data});
    });
})

const auth = (req, res, next) => {
    if (req.body.secret !== SECRET_KEY) {
        return res.json({status: '401', message: 'unauthorized'});
    }

    return next();
};

app.post('/api/rtsp/create', [auth], (req, res) => {
    db.run("INSERT INTO rtsp_link VALUES (?,?)", [req.body.name, req.body.link], (err) => {
        if (err) {
            res.json({status: '500', message: err.message, code: err.code});
        } else {
            res.json({status: '200', message: 'success'});
        }
    });
});

app.post('/api/rtsp/update/:name', [auth], (req, res) => {
    db.get("SELECT rowid AS id, name, link FROM rtsp_link WHERE name = ? LIMIT 1", [req.params.name], (err, row) => {
        if (err) {
            return res.json({status: '500', message: err.message, code: err.code});
        }

        if (!row) {
            return res.json({status: '404', message: 'Not found', code: 404});
        }

        db.run("UPDATE rtsp_link SET link =?, name=? WHERE rowid =?", [req.body.link, req.body.name,row.id], (err) => {
            if (err) {
                return res.json({status: '500', message: err.message, code: err.code});
            }
            return res.json({status: '200', message: 'success'});
        });
    });
});

app.post('/api/rtsp/delete/:name', [auth], (req, res) => {
    db.run("DELETE FROM rtsp_link WHERE name =?", [req.params.name], (err) => {
        if (err) {
            return res.json({status: '500', message: err.message, code: err.code});
        }

        return res.json({status: '200', message: 'success'});
    });
});

app.use('/public', express.static('public'))

app.listen(process.env.RTSP_SERVER_PORT, () => {
    console.log('start server: http://127.0.0.1:' + process.env.RTSP_SERVER_PORT);
});