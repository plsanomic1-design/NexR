const fs = require('fs');
const dotenv = require('dotenv');
dotenv.config();

const code = fs.readFileSync('server.js', 'utf8');

eval(code + `

(async () => {
    try {
        console.log('Testing persistAccountSave...');
        const s = {
            username: 'TestUser',
            robloxUserId: 12345,
            balance: 50,
            stats: {},
            transactions: []
        };
        const res = await persistAccountSave(12345, s);
        console.log('Result:', res);
    } catch(err) {
        console.error('Crash:', err);
    }
    process.exit(0);
})();
`);
