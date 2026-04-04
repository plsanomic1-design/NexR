const noblox = require('noblox.js');
async function test() {
    try {
        const productInfo = await noblox.getProductInfo(1784222735); 
        console.log("Result:", JSON.stringify(productInfo, null, 2));
    } catch(err) {
        console.error("Error:", err.message);
    }
}
test();
