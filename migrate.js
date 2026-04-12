const fs = require('fs');
let s = fs.readFileSync('server.js', 'utf8');

// select
s = s.replace(/select=balance_zr,balance_zh/g, 'select=balance');

// getUserBalance return 0
s = s.replace(/return \{ balance_zr: 0, balance_zh: 0 \};/g, 'return { balance: 0 };');

// getUserBalance return actual
s = s.replace(/balance_zr: num\(rows\[0\]\.balance_zr, 0\),\s*balance_zh: num\(rows\[0\]\.balance_zh, 0\)/g, 'balance: num(rows[0].balance, 0)');

// updateUserBalance signature
s = s.replace(/(async function updateUserBalance\(userId,\s*)balanceZr,\s*legacyBalanceZh\s*=\s*0(\s*\))/g, '$1balance$2');

// updateUserBalance payload (insert / patch)
s = s.replace(/balance_zr:\s*balanceZr\s*\+\s*legacyBalanceZh,\s*balance_zh:\s*0,/g, 'balance: balance,');

// updateUserBalance fallback loop
s = s.replace(/balance_zr:\s*row\.balance_zr,\s*balance_zh:\s*0,/g, 'balance: row.balance,');

// loadAccountFromSupabase mappings
s = s.replace(/balance:\s*bal\.balance_zr\s*\+\s*\(bal\.balance_zh \|\| 0\),/g, 'balance: bal.balance,');

// specific game balance checks:
s = s.replace(/const currentBal = await getUserBalance\(userId\);\s*if \(!currentBal \|\| currentBal\.balance_zr < amountCoins\)/g, 'const currentBal = await getUserBalance(userId);\nif (!currentBal || currentBal.balance < amountCoins)');
s = s.replace(/if \(currentBal\.balance_zr < amountCoins\)/g, 'if (currentBal.balance < amountCoins)');

s = s.replace(/const currentBalance = bal \? \(bal\.balance_zr \+ \(bal\.balance_zh \|\| 0\)\) : 0;/g, 'const currentBalance = bal ? bal.balance : 0;');
s = s.replace(/const currentBalance = bal\.balance_zr \+ \(bal\.balance_zh \|\| 0\);/g, 'const currentBalance = bal.balance;');


// deductUserBet 
const deductOld = `    const totalBal = bal.balance_zr + (bal.balance_zh || 0);\n    if (totalBal < bet - 0.001) return { ok: false, error: 'Insufficient balance.' };\n    \n    let newZr = bal.balance_zr;\n    let newZh = bal.balance_zh || 0;\n    \n    if (newZr >= bet) {\n        newZr -= bet;\n    } else {\n        const diff = bet - newZr;\n        newZr = 0;\n        newZh -= diff;\n    }\n    \n    newZr = Math.max(0, Math.round(newZr * 100) / 100);\n    newZh = Math.max(0, Math.round(newZh * 100) / 100);\n    const result = await updateUserBalance(uid, newZr, newZh);\n    if (!result.ok) return { ok: false, error: 'Could not update balance. Try again.' };\n    return { ok: true, newBalance: newZr + newZh, balanceZh: newZh };`;

const deductNew = `    if (bal.balance < bet - 0.001) return { ok: false, error: 'Insufficient balance.' };\n    const newBalance = Math.max(0, Math.round((bal.balance - bet) * 100) / 100);\n    const result = await updateUserBalance(uid, newBalance);\n    if (!result.ok) return { ok: false, error: 'Could not update balance. Try again.' };\n    return { ok: true, newBalance };`;

s = s.replace(deductOld, deductNew);

// creditUserWin
const creditOld = `    let newZr = bal.balance_zr;\n    let newZh = bal.balance_zh || 0;\n    let result = { ok: true };\n    if (winAmount > 0) {\n        newZr = Math.round((newZr + winAmount) * 100) / 100;\n        result = await updateUserBalance(uid, newZr, newZh);\n    }\n    // Push the authoritative balance to every open tab for this user\n    emitBalanceRemoteSync(io, uid, { balance: newZr + newZh, balanceZh: newZh, stats: {} });\n    return { ok: result.ok, newBalance: newZr + newZh, balanceZh: newZh };`;

const creditNew = `    let newBalance = bal.balance;\n    let result = { ok: true };\n    if (winAmount > 0) {\n        newBalance = Math.round((bal.balance + winAmount) * 100) / 100;\n        result = await updateUserBalance(uid, newBalance);\n    }\n    // Push the authoritative balance to every open tab for this user\n    emitBalanceRemoteSync(io, uid, { balance: newBalance, stats: {} });\n    return { ok: result.ok, newBalance };`;

s = s.replace(creditOld, creditNew);

// update calls with three args 
s = s.replace(/updateUserBalance\((.+?),\s*(.+?),\s*(?:0|bal\.balance_zh|currentBal\.balance_zh|num\(save\.balanceZh,\s*0\))\)/g, 'updateUserBalance($1, $2)');

// Fix manual sync events
s = s.replace(/emitBalanceRemoteSync\(([^,]+?),\s*([^,]+?),\s*\{\s*balance:\s*([^,]+?),\s*balanceZh:[^,]+?,\s*stats:\s*\{\}\s*\}\)/g, 'emitBalanceRemoteSync($1, $2, { balance: $3, stats: {} })');

// delete legacy fields specifically
s = s.replace(/delete save\.balanceZh;/g, '');
s = s.replace(/let save = diskSave \? \{ \.\.\.diskSave \} : \{ balance: 0, balanceZh: 0, stats: \{\} \};/g, 'let save = diskSave ? { ...diskSave } : { balance: 0, stats: {} };');

fs.writeFileSync('server.js', s);

let sc = fs.readFileSync('script.js', 'utf8');
sc = sc.replace(/balanceZh: typeof save\.balanceZh === 'number' \? save\.balanceZh : 0,/g, '');
sc = sc.replace(/balanceZh: 0/g, ''); 
sc = sc.replace(/balanceZh: deduct\.balanceZh,/g, '');
sc = sc.replace(/balanceZh: bal\.balance_zh,/g, '');
fs.writeFileSync('script.js', sc);
