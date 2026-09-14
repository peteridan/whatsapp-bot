require('dotenv').config();

process.on('uncaughtException', (err) => {
    console.error('Uncaught exception (keeping process alive):', err);
});

process.on('unhandledRejection', (reason) => {
    console.error('Unhandled promise rejection (keeping process alive):', reason);
});

const config = require('./lib/config');
const state = require('./lib/state');
const storeModule = require('./lib/store');
const utils = require('./lib/utils');
const socket = require('./lib/socket');
const routes = require('./lib/routes');

state.store = storeModule.loadStore();

async function startBot() {
    try {
        if (!config.GROQ_MODEL && config.getGroqModel) {
            const model = await config.getGroqModel();
            config.GROQ_MODEL = model;
            console.log('Resolved Groq model:', model);
        }

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
    } catch (error) {
        console.error('Bot start failed, retrying in 3 seconds:', error);
        await utils.delay(3000);
        startBot();
    }
}

startBot();
