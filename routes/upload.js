const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');

// Ensure uploads directory exists
const uploadDir = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(uploadDir)){
    fs.mkdirSync(uploadDir, { recursive: true });
}

// Configure Multer Storage
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    // Sanitize filename to be safe
    const safeName = file.originalname.replace(/[^a-zA-Z0-9.]/g, '_');
    cb(null, uniqueSuffix + safeName);
  }
});

const upload = multer({ storage: storage });

// POST /api/upload
router.post('/', upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ msg: 'No file uploaded' });
  }
  
  // Construct URL dynamically based on request
  // Use /api/upload/filename pattern so the GET route below can serve it
  const protocol = req.headers['x-forwarded-proto'] || req.protocol;
  const host = req.get('host');
  
  // Use /api/upload/filename so the GET route handles it
  const fileUrl = `${protocol}://${host}/api/upload/${req.file.filename}`;
  
  res.json({ url: fileUrl, filename: req.file.filename });
});

// GET /api/upload/:filename - Serve the uploaded file
router.get('/:filename', (req, res) => {
  const filename = req.params.filename;
  
  // Prevent directory traversal
  if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
    return res.status(400).json({ msg: 'Invalid filename' });
  }

  const filePath = path.join(uploadDir, filename);
  
  if (fs.existsSync(filePath)) {
    res.sendFile(filePath);
  } else {
    res.status(404).json({ msg: 'File not found' });
  }
});

module.exports = router;