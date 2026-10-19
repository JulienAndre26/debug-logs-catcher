import crypto from 'node:crypto';
import http from 'node:http';

// A local HTTP server on a random port. routes maps a path to { type, body }, body being a string or a function
// returning one. /ws is a minimal WebSocket endpoint: handshake, then one text frame "hello-from-ws".
export function serve(host, routes) {
    const server = http.createServer((req, res) => {
        const route = routes[new URL(req.url, 'http://host').pathname];
        if (!route) {
            res.writeHead(404);
            res.end();
            return;
        }
        res.writeHead(200, { 'Content-Type': route.type });
        res.end(typeof route.body === 'function' ? route.body() : route.body);
    });
    server.on('upgrade', (req, socket) => {
        const accept = crypto.createHash('sha1')
            .update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
        socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
            'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n');
        const payload = Buffer.from('hello-from-ws');
        socket.write(Buffer.concat([Buffer.from([0x81, payload.length]), payload]));
        socket.on('data', () => {});
        socket.on('error', () => {});
    });
    return new Promise((resolve) => server.listen(0, host, () => resolve({
        origin: `http://${host}:${server.address().port}`,
        close: () => {
            server.closeAllConnections();
            server.close();
        }
    })));
}
