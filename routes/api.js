const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const Models = require('../models/SchemaDefinitions');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');

// --- CONFIGURATION ---
// Primary model to try first
const PRIMARY_MODEL = "gemini-2.5-flash"; 
// Fallback model if primary is overloaded (503)
const FALLBACK_MODEL = "gemini-2.0-flash"; 

// Helper to Convert URL to Inline Data for Gemini
function getFileHandler(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const mediaTypes = {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', 
    '.webp': 'image/webp', '.pdf': 'application/pdf'
  };
  // Text types we should read and append to prompt
  const textTypes = [
    '.txt', '.md', '.csv', '.json', '.js', '.jsx', '.ts', '.tsx', 
    '.html', '.css', '.py', '.java', '.c', '.cpp', '.env'
  ];

  if (mediaTypes[ext]) return { type: 'media', mimeType: mediaTypes[ext] };
  if (textTypes.includes(ext)) return { type: 'text' };
  return { type: 'unsupported' };
}

// ==========================================
// 1. Generic Entity Routes (BaaS)
// ==========================================

router.post('/entities/:entity/filter', async (req, res) => {
  try {
    const Model = Models[req.params.entity];
    if (!Model) return res.status(400).json({ msg: `Entity not found` });
    
    const { filters = {}, sort } = req.body;
    if ((filters._id && !mongoose.Types.ObjectId.isValid(filters._id)) || 
        (filters.id && !mongoose.Types.ObjectId.isValid(filters.id))) {
      return res.json([]);
    }

    let query = Model.find(filters);
    if (sort) {
      const sortObj = {};
      if (sort.startsWith('-')) sortObj[sort.substring(1)] = -1;
      else sortObj[sort] = 1;
      query = query.sort(sortObj);
    }
    res.json(await query.exec());
  } catch (err) { res.json([]); }
});

router.post('/entities/:entity/create', async (req, res) => {
  try {
    const Model = Models[req.params.entity];
    if (!Model) return res.status(400).json({ msg: `Entity not found` });
    const item = new Model(req.body);
    res.json(await item.save());
  } catch (err) { res.status(400).json({ error: err.message }); }
});

router.post('/entities/:entity/update', async (req, res) => {
  try {
    const Model = Models[req.params.entity];
    if (!Model) return res.status(400).json({ msg: `Entity not found` });
    if (!mongoose.Types.ObjectId.isValid(req.body.id)) return res.status(400).json({ error: "Invalid ID" });
    
    res.json(await Model.findByIdAndUpdate(req.body.id, req.body.data, { new: true }));
  } catch (err) { res.status(500).send(err.message); }
});

router.post('/entities/:entity/delete', async (req, res) => {
  try {
    const Model = Models[req.params.entity];
    if (!Model) return res.status(400).json({ msg: `Entity not found` });
    if (!mongoose.Types.ObjectId.isValid(req.body.id)) return res.status(400).json({ error: "Invalid ID" });
    
    await Model.findByIdAndDelete(req.body.id);
    res.json({ success: true });
  } catch (err) { res.status(500).send(err.message); }
});

// ==========================================
// 2. AI Integration Route (With Retry & Fallback)
// ==========================================

async function generateWithRetry(genAI, modelName, params, retries = 3) {
  try {
    const model = genAI.getGenerativeModel({ 
      model: modelName,
      generationConfig: params.generationConfig,
      systemInstruction: params.systemInstruction
    });
    
    return await model.generateContent(params.content);
  } catch (error) {
    const isOverloaded = error.message.includes('503') || error.message.includes('overloaded');
    
    if (isOverloaded && retries > 0) {
      console.log(`⚠️ Model ${modelName} overloaded. Retrying in 2s... (${retries} attempts left)`);
      await new Promise(resolve => setTimeout(resolve, 2000));
      return generateWithRetry(genAI, modelName, params, retries - 1);
    }
    
    // If retries exhausted or error is not 503, throw it
    throw error;
  }
}

router.post('/integrations/llm', async (req, res) => {
  const { prompt, response_json_schema, context, file_urls } = req.body;

  if (!process.env.GEMINI_API_KEY) {
    return res.json("AI Configuration Error: Missing GEMINI_API_KEY in .env");
  }

  try {
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    
    const generationConfig = {};
    if (response_json_schema) {
      generationConfig.responseMimeType = "application/json";
    }

    // Prepare system instructions
    const systemInstruction = context ? {
      role: "system",
      parts: [{ text: `You are Aivora, an intelligent project management assistant. \n\nSYSTEM DATA:\n${context}\n\nUse this data to answer questions.` }]
    } : undefined;

    // Build prompt parts
    const parts = [{ text: prompt }];

    // Handle Files
    if (file_urls && Array.isArray(file_urls)) {
      for (const url of file_urls) {
        if (url.includes('/uploads/')) {
          const filename = url.split('/uploads/')[1];
          const filePath = path.join(__dirname, '..', 'uploads', filename);
          
          if (fs.existsSync(filePath)) {
            const handler = getFileHandler(filePath);
            const fileBuffer = fs.readFileSync(filePath);

            if (handler.type === 'media') {
              parts.push({
                inlineData: {
                  data: fileBuffer.toString("base64"),
                  mimeType: handler.mimeType
                }
              });
            } else if (handler.type === 'text') {
              const fileContent = fileBuffer.toString('utf-8');
              parts.push({
                text: `\n\n--- FILE CONTENT: ${filename} ---\n${fileContent}\n--- END FILE ---\n`
              });
            }
          }
        }
      }
    }

    const content = { contents: [{ role: "user", parts }] };
    const params = { generationConfig, systemInstruction, content };

    let result;
    try {
      // Try primary model with retries
      result = await generateWithRetry(genAI, PRIMARY_MODEL, params);
    } catch (primaryError) {
      console.error(`❌ Primary model ${PRIMARY_MODEL} failed:`, primaryError.message);
      
      // Fallback to secondary model if it's a 503/404
      if (primaryError.message.includes('503') || primaryError.message.includes('404')) {
        console.log(`🔄 Switching to fallback model: ${FALLBACK_MODEL}`);
        result = await generateWithRetry(genAI, FALLBACK_MODEL, params, 1); // 1 retry for fallback
      } else {
        throw primaryError;
      }
    }

    const response = await result.response;
    let text = response.text();

    if (response_json_schema) {
        text = text.replace(/```json/g, '').replace(/```/g, '').trim();
        try {
            return res.json(JSON.parse(text));
        } catch (e) {
            return res.json({ error: "AI generated invalid JSON." });
        }
    }

    res.json(text);

  } catch (err) {
    console.error("❌ AI Error:", err.message);
    res.status(500).json({ 
      result: "I'm currently experiencing high traffic. Please try again in a moment." 
    });
  }
});

// ==========================================
// 3. Email Integration
// ==========================================

router.post('/integrations/email', async (req, res) => {
  const { to, subject, body } = req.body;
  if (!process.env.MAIL_USERNAME) return res.status(500).json({ error: "Email config missing" });

  try {
    const transporter = nodemailer.createTransport({
      host: process.env.MAIL_HOST,
      port: Number(process.env.MAIL_PORT),
      secure: false,
      auth: { user: process.env.MAIL_USERNAME, pass: process.env.MAIL_PASSWORD },
    });
    await transporter.sendMail({ from: `"${process.env.MAIL_FROM_NAME}" <${process.env.MAIL_FROM_ADDRESS}>`, to, subject, html: body });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: "Failed to send email" }); }
});

module.exports = router;