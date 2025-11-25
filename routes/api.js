const express = require('express');
const router = express.Router(); // <--- This line was missing and caused the crash
const Models = require('../models/SchemaDefinitions');
const OpenAI = require('openai');
const nodemailer = require('nodemailer');

// ==========================================
// 1. Generic Entity Routes (The "BaaS" Logic)
// ==========================================

// Generic List/Filter
router.post('/entities/:entity/filter', async (req, res) => {
  try {
    const modelName = req.params.entity;
    const Model = Models[modelName];
    
    if (!Model) return res.status(400).json({ msg: `Entity ${modelName} not found` });

    const { filters = {}, sort } = req.body;
    let query = Model.find(filters);
    
    if (sort) {
      // Handle sort string like '-created_date'
      const sortObj = {};
      if (sort.startsWith('-')) sortObj[sort.substring(1)] = -1;
      else sortObj[sort] = 1;
      query = query.sort(sortObj);
    }

    const results = await query.exec();
    res.json(results);
  } catch (err) {
    console.error(`Error listing ${req.params.entity}:`, err.message);
    res.status(500).send(err.message);
  }
});

// Generic Create
router.post('/entities/:entity/create', async (req, res) => {
  try {
    const modelName = req.params.entity;
    const Model = Models[modelName];
    if (!Model) return res.status(400).json({ msg: `Entity ${modelName} not found` });

    // --- FIX: Auto-inject tenant_id if missing ---
    const payload = { ...req.body };
    if (!payload.tenant_id) {
      payload.tenant_id = "default-tenant"; 
    }
    // ---------------------------------------------

    const newItem = new Model(payload);
    const savedItem = await newItem.save();
    res.json(savedItem);
  } catch (err) {
    console.error(`Error creating ${req.params.entity}:`, err.message);
    // Don't crash the app, send a 400 error
    res.status(400).json({ error: err.message });
  }
});

// Generic Update
router.post('/entities/:entity/update', async (req, res) => {
  try {
    const modelName = req.params.entity;
    const Model = Models[modelName];
    if (!Model) return res.status(400).json({ msg: `Entity ${modelName} not found` });

    const { id, data } = req.body;
    const updatedItem = await Model.findByIdAndUpdate(id, data, { new: true });
    res.json(updatedItem);
  } catch (err) {
    console.error(`Error updating ${req.params.entity}:`, err.message);
    res.status(500).send(err.message);
  }
});

// Generic Delete
router.post('/entities/:entity/delete', async (req, res) => {
  try {
    const modelName = req.params.entity;
    const Model = Models[modelName];
    if (!Model) return res.status(400).json({ msg: `Entity ${modelName} not found` });

    await Model.findByIdAndDelete(req.body.id);
    res.json({ success: true });
  } catch (err) {
    console.error(`Error deleting ${req.params.entity}:`, err.message);
    res.status(500).send(err.message);
  }
});

// ==========================================
// 2. AI Integration Route (Groq / Llama 3)
// ==========================================

router.post('/integrations/llm', async (req, res) => {
  const { prompt } = req.body;

  // Check if API Key is configured
  if (!process.env.OPENAI_API_KEY) {
    console.warn("⚠️ AI Call failed: Missing OPENAI_API_KEY in .env");
    return res.json({ 
      result: "⚠️ AI Config Missing: Please add your Groq API Key to backend/.env as OPENAI_API_KEY" 
    });
  }

  try {
    // Configure client to point to Groq's servers
    const openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      baseURL: "https://api.groq.com/openai/v1" 
    });

    const completion = await openai.chat.completions.create({
      messages: [
        { role: "system", content: "You are Aivora, a helpful project management AI assistant." },
        { role: "user", content: prompt }
      ],
      model: "llama-3.1-8b-instant", 
    });

    // Send back just the text result
    const aiResponse = completion.choices[0].message.content;
    res.json(aiResponse);

  } catch (err) {
    console.error("❌ AI Error:", err.message);
    // Return a friendly error so the frontend doesn't crash
    res.json({ 
      result: "I encountered an error connecting to the AI brain. Please check the backend logs." 
    });
  }
});

// In routes/api.js

router.post('/integrations/email', async (req, res) => {
  const { to, subject, body } = req.body;

  // Check if credentials exist
  if (!process.env.MAIL_USERNAME || !process.env.MAIL_PASSWORD) {
    return res.status(500).json({ error: "Server email configuration missing" });
  }

  try {
    const transporter = nodemailer.createTransport({
      host: process.env.MAIL_HOST, // smtp.gmail.com
      port: Number(process.env.MAIL_PORT), // 587
      secure: false, // false for 587, true for 465
      auth: {
        user: process.env.MAIL_USERNAME,
        pass: process.env.MAIL_PASSWORD,
      },
    });

    await transporter.sendMail({
      from: `"${process.env.MAIL_FROM_NAME}" <${process.env.MAIL_FROM_ADDRESS}>`,
      to,
      subject,
      html: body,
    });

    res.json({ success: true });
  } catch (err) {
    console.error("Email Error:", err);
    res.status(500).json({ error: "Failed to send email: " + err.message });
  }
});
module.exports = router;