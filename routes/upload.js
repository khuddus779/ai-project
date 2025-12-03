/* routes/upload.js */
const express = require('express');
const router = express.Router();
const multer = require('multer');
const ImageKit = require("imagekit");

// 1. Initialize ImageKit with credentials from .env
// (We use environment variables to keep your Private Key secure)
const imagekit = new ImageKit({
    publicKey: process.env.IMAGEKIT_PUBLIC_KEY,
    privateKey: process.env.IMAGEKIT_PRIVATE_KEY,
    urlEndpoint: process.env.IMAGEKIT_URL_ENDPOINT
});

// 2. Configure Multer to use Memory Storage
// This keeps the file in RAM briefly instead of saving to the ephemeral disk
const storage = multer.memoryStorage();
const upload = multer({ 
    storage: storage,
    limits: {
        fileSize: 5 * 1024 * 1024 // Limit file size to 5MB for safety
    }
});

// POST /api/upload
router.post('/', upload.single('file'), async (req, res) => {
  try {
      if (!req.file) {
        return res.status(400).json({ msg: 'No file uploaded' });
      }

      // 3. Upload to ImageKit
      const result = await imagekit.upload({
          file: req.file.buffer, // The file data from memory
          fileName: req.file.originalname,
          folder: "/user_uploads" // Optional: Organize uploads in a folder
      });

      // 4. Return the permanent URL from ImageKit
      // This matches the structure your frontend expects ({ url: ... })
      res.json({ 
        url: result.url, 
        filename: result.name,
        fileId: result.fileId
      });

  } catch (error) {
      console.error("[Upload] ImageKit Error:", error);
      res.status(500).json({ msg: 'Failed to upload image to cloud storage' });
  }
});

module.exports = router;