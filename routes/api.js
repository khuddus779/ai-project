const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const Models = require('../models/SchemaDefinitions');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');

// --- CONFIGURATION ---
const PRIMARY_MODEL = "gemini-2.0-flash"; // Updated for stability
const FALLBACK_MODEL = "gemini-1.5-flash"; 

// Helper to Convert URL to Inline Data for Gemini
function getFileHandler(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const mediaTypes = {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', 
    '.webp': 'image/webp', '.pdf': 'application/pdf'
  };
  const textTypes = [
    '.txt', '.md', '.csv', '.json', '.js', '.jsx', '.ts', '.tsx', 
    '.html', '.css', '.py', '.java', '.c', '.cpp', '.env'
  ];

  if (mediaTypes[ext]) return { type: 'media', mimeType: mediaTypes[ext] };
  if (textTypes.includes(ext)) return { type: 'text' };
  return { type: 'unsupported' };
}

// AI Helper
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
      console.log(`⚠️ Model ${modelName} overloaded. Retrying...`);
      await new Promise(resolve => setTimeout(resolve, 2000));
      return generateWithRetry(genAI, modelName, params, retries - 1);
    }
    throw error;
  }
}

// ==========================================
// 1. Generic Entity Routes (BaaS)
// ==========================================

router.post('/entities/:entity/filter', async (req, res) => {
  try {
    const Model = Models[req.params.entity];
    if (!Model) return res.status(400).json({ msg: `Entity not found` });
    
    const { filters = {}, sort } = req.body;
    
    // Sanitize filters
    const cleanFilters = {};
    for (const key in filters) {
      if (filters[key] !== undefined && filters[key] !== '') {
        cleanFilters[key] = filters[key];
      }
    }

    let query = Model.find(cleanFilters);
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
// 2. NEW: AI Sprint Task Generation Route
// ==========================================

router.post('/ai/generate-sprint-tasks', async (req, res) => {
  const { sprintId, projectId, workspaceId, tenantId, goal, userEmail } = req.body;

  if (!process.env.GEMINI_API_KEY) {
    return res.status(500).json({ error: "AI Configuration Error" });
  }
  if (!projectId || !tenantId || !workspaceId) {
    return res.status(400).json({ error: "Missing required context (projectId, tenantId, or workspaceId)" });
  }

  try {
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    
    const prompt = `You are an expert project manager. Create 5-8 concrete, actionable tasks for a sprint.
    
    Sprint Goal: "${goal || 'General project progress'}"
    
    Return a JSON object with a "tasks" array. Each task must have:
    - title (string)
    - description (string)
    - task_type (enum: "story", "bug", "task", "technical_debt")
    - priority (enum: "low", "medium", "high", "urgent")
    - estimated_hours (number)
    - acceptance_criteria (string)
    `;

    const params = {
      generationConfig: { responseMimeType: "application/json" },
      content: { contents: [{ role: "user", parts: [{ text: prompt }] }] }
    };

    let result;
    try {
      result = await generateWithRetry(genAI, PRIMARY_MODEL, params);
    } catch (e) {
      result = await generateWithRetry(genAI, FALLBACK_MODEL, params);
    }

    const text = result.response.text();
    const aiData = JSON.parse(text);
    const tasks = aiData.tasks || [];

    // Augment tasks with system data
    const tasksToCreate = tasks.map(t => ({
      ...t,
      tenant_id: tenantId,
      project_id: projectId,
      workspace_id: workspaceId,
      sprint_id: sprintId,
      status: 'todo',
      ai_generated: true,
      reporter: userEmail,
      created_date: new Date(),
      updated_date: new Date()
    }));

    if (tasksToCreate.length === 0) {
      return res.json({ message: "No tasks generated", tasks: [] });
    }

    // Bulk Insert
    const createdTasks = await Models.Task.insertMany(tasksToCreate);

    // Log Activity (Single log for the batch)
    try {
      await Models.Activity.create({
        tenant_id: tenantId,
        action: 'created',
        entity_type: 'sprint',
        entity_id: sprintId,
        entity_name: 'AI Tasks',
        project_id: projectId,
        user_email: userEmail,
        details: `AI generated ${createdTasks.length} tasks based on goal: ${goal}`
      });
    } catch (e) { console.error("Activity log failed", e); }

    res.json({ success: true, tasks: createdTasks });

  } catch (err) {
    console.error("AI Task Gen Error:", err);
    res.status(500).json({ error: "Failed to generate tasks: " + err.message });
  }
});

// ==========================================
// 3. Standard AI Route
// ==========================================

router.post('/integrations/llm', async (req, res) => {
  const { prompt, response_json_schema, context, file_urls } = req.body;

  if (!process.env.GEMINI_API_KEY) {
    return res.json("AI Configuration Error: Missing GEMINI_API_KEY in .env");
  }

  try {
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const generationConfig = response_json_schema ? { responseMimeType: "application/json" } : {};
    
    const parts = [{ text: prompt }];
    if (context) parts.push({ text: `CONTEXT:\n${context}` });
    
    const params = {
        generationConfig,
        content: { contents: [{ role: "user", parts }] }
    };

    const result = await generateWithRetry(genAI, PRIMARY_MODEL, params);
    const text = result.response.text();

    if (response_json_schema) {
        // FIX: Clean markdown code blocks before parsing
        const cleanText = text.replace(/```json\n?|\n?```/g, '').trim();
        try { 
            return res.json(JSON.parse(cleanText)); 
        } catch (e) { 
            console.error("JSON Parse Error:", e.message);
            // Fallback: try to find JSON object if mixed content
            const jsonMatch = cleanText.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                try { return res.json(JSON.parse(jsonMatch[0])); } catch(e2) {}
            }
            return res.json({ error: "Invalid JSON response from AI" }); 
        }
    }
    res.json(text);

  } catch (err) {
    console.error("AI Route Error:", err);
    res.status(500).json({ result: "AI Service currently unavailable." });
  }
});
// ==========================================
// 4. Email Integration
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