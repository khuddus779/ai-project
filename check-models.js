// check-models.js
require('dotenv').config();

async function listModels() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error("❌ No GEMINI_API_KEY found in .env file");
    return;
  }

  console.log("🔍 Checking available Gemini models...");
  
  try {
    // We use the REST API directly to avoid SDK version conflicts
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
    const data = await response.json();

    if (data.error) {
      console.error("❌ API Error:", data.error.message);
      return;
    }

    if (!data.models) {
      console.log("⚠️ No models found. Check your API key permissions.");
      return;
    }

    console.log("\n✅ AVAILABLE MODELS:");
    const validModels = data.models
      .filter(m => m.supportedGenerationMethods.includes("generateContent"))
      .map(m => m.name.replace("models/", ""));
      
    validModels.forEach(name => console.log(`- ${name}`));

    console.log("\n👉 RECOMMENDED FIX: Update your 'routes/api.js' to use one of the names above (e.g., 'gemini-1.5-flash-001').");
    
  } catch (error) {
    console.error("❌ Network Error:", error.message);
  }
}

listModels();