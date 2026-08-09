require('dotenv').config();

const config = require('./lib/config');
const state = require('./lib/state');
const storeModule = require('./lib/store');
const utils = require('./lib/utils');
const socket = require('./lib/socket');
const routes = require('./lib/routes');

state.store = storeModule.loadStore();

async function ensureStartedWhenOnline() {
    while (true) {
        const online = await utils.hasInternetConnection();

        if (online) {
            try {
                socket.startSock();

                const server = routes.createServerInstance();
                server.listen(config.PORT, () => {
                    console.log('Health endpoint listening on port ' + config.PORT);
                });

                server.on('error', (err) => {
                    if (err && err.code === 'EADDRINUSE') {
                        console.error(`Port ${config.PORT} is already in use. Set PORT to a different value or free the port and retry.`);
                        console.error('On Windows: run `netstat -ano | findstr :' + config.PORT + '` to find the PID, then `taskkill /PID <pid> /F` to stop it.');
                        process.exit(1);
                    }
                    console.error('Server error:', err);
                    process.exit(1);
                });

                return;
            } catch (error) {
                console.error('Bot start failed, retrying in 3 seconds:', error);
            }
        } else {
            console.log('No internet connection available. Retrying in 3 seconds...');
        }

        await utils.delay(3000);
    }
}

ensureStartedWhenOnline().catch((error) => {
    console.error('Client initialization failed:', error);
});
