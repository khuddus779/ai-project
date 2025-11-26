// test-gemini.js
require('dotenv').config();
const { GoogleGenerativeAI } = require("@google/generative-ai");

async function test() {
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  
  try {
    console.log("1. Testing API Key connection...");
    // Use a known stable model first to test connection
    const model = genAI.getGenerativeModel({ model: "gemini-pro" });
    const result = await model.generateContent("Hello");
    console.log("✅ Connection successful! Response:", result.response.text());
    
    console.log("\n2. Listing available models for your key...");
    // Note: The SDK doesn't have a direct 'listModels' helper exposed easily in all versions,
    // but if the above worked, your key is valid.
    // The error you saw specifically mentioned 'gemini-1.5-flash'.
    
    console.log("3. Testing gemini-1.5-flash-001 (Specific Version)...");
    const flashModel = genAI.getGenerativeModel({ model: "gemini-1.5-flash-001" });
    const flashResult = await flashModel.generateContent("Are you working?");
    console.log("✅ gemini-1.5-flash-001 is WORKING!");
    
  } catch (error) {
    console.error("❌ Error Details:", error.message);
    if (error.message.includes('404')) {
      console.log("\n💡 FIX: Your API key might not have access to 'Flash'. Try using 'gemini-pro' in your code.");
    }
  }
}

test();