const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const Models = require('../models/SchemaDefinitions');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

// --- CONFIGURATION ---
const PRIMARY_MODEL = "gemini-2.0-flash"; 
const FALLBACK_MODEL = "gemini-1.5-flash"; 

// Helper: Robustly find a file in common upload directories
function findFileLocally(filename) {
  // Clean filename to remove URL parameters or path traversal attempts
  const cleanName = path.basename(filename);
  
  const possiblePaths = [
    path.join(__dirname, '..', 'uploads', cleanName),        // routes/../uploads
    path.join(process.cwd(), 'uploads', cleanName),          // root/uploads
    path.join(process.cwd(), 'public', 'uploads', cleanName),// root/public/uploads
    path.join(__dirname, 'uploads', cleanName),              // routes/uploads
    // Fallback for some cloud environments
    path.join('/tmp', cleanName)
  ];

  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
        console.log(`[AI API] Found file locally at: ${p}`);
        return p;
    }
  }
  console.warn(`[AI API] File not found locally: ${cleanName}. Checked paths:`, possiblePaths);
  return null;
}

// Helper: Detect file type and return handler
function getFileHandler(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  
  const mediaTypes = {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', 
    '.webp': 'image/webp', '.pdf': 'application/pdf',
    '.heic': 'image/heic', '.heif': 'image/heif'
  };
  
  const textTypes = [
    '.txt', '.md', '.csv', '.json', '.js', '.jsx', '.ts', '.tsx', 
    '.html', '.css', '.scss', '.py', '.java', '.c', '.cpp', '.h', 
    '.hpp', '.cs', '.go', '.rb', '.php', '.swift', '.kt', '.sql', 
    '.sh', '.bat', '.ps1', '.env', '.xml', '.yaml', '.yml', '.ini',
    '.log', '.conf'
  ];

  if (mediaTypes[ext]) return { type: 'media', mimeType: mediaTypes[ext] };
  if (textTypes.includes(ext)) return { type: 'text' };
  
  // Default to text if unknown but likely text
  return { type: 'unsupported' }; 
}

function extractJSON(text) {
  try {
    return JSON.parse(text);
  } catch (e) {
    const match = text.match(/```json([\s\S]*?)```/);
    if (match) {
      try { return JSON.parse(match[1]); } catch (e2) { }
    }
    const firstOpen = text.indexOf('{');
    const lastClose = text.lastIndexOf('}');
    if (firstOpen !== -1 && lastClose !== -1) {
      try { return JSON.parse(text.substring(firstOpen, lastClose + 1)); } catch (e3) { }
    }
    return null;
  }
}

// AI Helper with Retry Logic
async function generateWithRetry(genAI, modelName, params, retries = 3) {
    try {
      const model = genAI.getGenerativeModel({ 
        model: modelName,
        generationConfig: params.generationConfig,
        systemInstruction: params.systemInstruction
      });
      return await model.generateContent(params.content);
    } catch (error) {
      console.error(`[AI API] Model ${modelName} failed: ${error.message}`);
      if (retries > 0) {
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
// 2. AI Sprint Task Generation Route
// ==========================================

router.post('/ai/generate-sprint-tasks', async (req, res) => {
  const { sprintId, projectId, workspaceId, tenantId, goal, userEmail } = req.body;

  if (!process.env.GEMINI_API_KEY) return res.status(500).json({ error: "AI Configuration Error" });
  if (!projectId || !tenantId || !workspaceId) return res.status(400).json({ error: "Missing required context" });

  try {
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    
    const prompt = `You are an expert project manager. Create 5-8 concrete, actionable tasks for a sprint.
    Sprint Goal: "${goal || 'General project progress'}"
    Return a JSON object with a "tasks" array.`;

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

    if (tasksToCreate.length > 0) {
       const createdTasks = await Models.Task.insertMany(tasksToCreate);
       try {
         await Models.Activity.create({
           tenant_id: tenantId, action: 'created', entity_type: 'sprint', entity_id: sprintId,
           entity_name: 'AI Tasks', project_id: projectId, user_email: userEmail,
           details: `AI generated ${createdTasks.length} tasks`
         });
       } catch (e) {}
       return res.json({ success: true, tasks: createdTasks });
    }
    
    res.json({ message: "No tasks generated", tasks: [] });

  } catch (err) {
    res.status(500).json({ error: "Failed to generate tasks: " + err.message });
  }
});

// ==========================================
// 3. Standard AI Route (FIXED FOR ROBUST FILE HANDLING)
// ==========================================

router.post('/integrations/llm', async (req, res) => {
  const { prompt, response_json_schema, context, file_urls } = req.body;

  if (!process.env.GEMINI_API_KEY) return res.status(500).json({ error: "AI Configuration Error" });

  try {
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const generationConfig = response_json_schema ? { responseMimeType: "application/json" } : {};
    
    const parts = [];
    const skippedFiles = [];
    const loadedFiles = [];
    
    // 1. Handle File Attachments
    if (file_urls && Array.isArray(file_urls) && file_urls.length > 0) {
        for (const url of file_urls) {
            try {
                // Decode filename (handles spaces like "Project Specs.pdf")
                const cleanUrl = decodeURIComponent(url);
                const filename = cleanUrl.split('/').pop();
                const handler = getFileHandler(filename);

                if (handler.type === 'unsupported') {
                    console.warn(`[AI API] Unsupported file type for: ${filename}`);
                    skippedFiles.push(`${filename} (Unsupported Type)`);
                    continue;
                }

                let processed = false;
                
                // A. Try Local File System First (Fastest & Most Reliable)
                const localPath = findFileLocally(filename);
                
                if (localPath) {
                    try {
                        if (handler.type === 'text') {
                            const textContent = fs.readFileSync(localPath, 'utf8');
                            parts.push({ text: `\n\n--- FILE START: ${filename} ---\n${textContent}\n--- FILE END ---\n` });
                            processed = true;
                        } else if (handler.type === 'media') {
                            const fileBuffer = fs.readFileSync(localPath);
                            parts.push({
                                inlineData: {
                                    data: fileBuffer.toString('base64'),
                                    mimeType: handler.mimeType
                                }
                            });
                            processed = true;
                        }
                        if (processed) loadedFiles.push(filename);
                    } catch (readErr) {
                        console.error(`[AI API] Error reading local file ${localPath}:`, readErr);
                    }
                }

                // B. Fallback to HTTP Download (If file is remote or path failed)
                if (!processed) {
                    // Fix Relative URLs: If url is "/uploads/..." prepend the host
                    let downloadUrl = url;
                    if (url.startsWith('/')) {
                        const protocol = req.protocol || 'http';
                        const host = req.get('host');
                        downloadUrl = `${protocol}://${host}${url}`;
                    }

                    console.log(`[AI API] Attempting download fallback: ${downloadUrl}`);
                    const response = await axios.get(downloadUrl, { responseType: 'arraybuffer' });
                    
                    if (handler.type === 'text') {
                         const textContent = Buffer.from(response.data).toString('utf8');
                         parts.push({ text: `\n\n--- FILE START: ${filename} ---\n${textContent}\n--- FILE END ---\n` });
                    } else {
                         const mimeType = response.headers['content-type'] || handler.mimeType;
                         parts.push({
                             inlineData: {
                                 data: Buffer.from(response.data).toString('base64'),
                                 mimeType: mimeType
                             }
                         });
                    }
                    loadedFiles.push(filename);
                }
            } catch (fileError) {
                console.error("[AI API] Attachment Processing Error:", url, fileError.message);
                skippedFiles.push(`${url.split('/').pop()} (Read Failed)`);
            }
        }
    }

    // 2. Construct Final Prompt
    let finalPrompt = "";
    
    // Explicitly tell AI about the files so it doesn't ignore them
    if (loadedFiles.length > 0) {
        finalPrompt += `[SYSTEM: The user has attached ${loadedFiles.length} file(s): ${loadedFiles.join(', ')}. You MUST analyze these files to answer the user's query. Do not ignore them.]\n\n`;
    }
    
    if (skippedFiles.length > 0) {
        finalPrompt += `[SYSTEM WARNING: Could not read these files: ${skippedFiles.join(', ')}. Please inform the user.]\n\n`;
    }

    finalPrompt += `USER QUERY: ${prompt}`;
    
    if (response_json_schema) {
      finalPrompt += "\n\nIMPORTANT: Return ONLY valid JSON.";
    }
    
    parts.push({ text: finalPrompt });
    
    // 3. Add Context (As secondary info)
    if (context) {
        parts.push({ text: `\n\n[BACKGROUND CONTEXT]\n${context}` });
    }
    
    const params = {
        generationConfig,
        content: { contents: [{ role: "user", parts }] },
        systemInstruction: {
            parts: [{ text: "You are a project assistant. Priority #1: Analyze the attached files (PDFs, Images, Code) if any are present. Use the file content as the primary source of truth. Priority #2: Answer the user's question accurately." }]
        }
    };

    const result = await generateWithRetry(genAI, PRIMARY_MODEL, params);
    const text = result.response.text();

    if (response_json_schema) {
        const jsonObj = extractJSON(text);
        if (jsonObj) return res.json(jsonObj);
        return res.status(500).json({ error: "Failed to generate valid JSON" });
    }
    
    res.json(text);

  } catch (err) {
    console.error("AI Route Error:", err);
    res.status(500).json({ error: "AI Service unavailable: " + err.message });
  }
});

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