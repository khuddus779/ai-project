const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');

// 1. Helper: Convert JSON types to Mongoose types
const convertType = (field) => {
  let schemaType = {};

  // Handle Types
  if (field.type === 'string') {
    if (field.format === 'date' || field.format === 'date-time') {
      schemaType.type = Date;
    } else {
      schemaType.type = String;
    }
  } else if (field.type === 'number' || field.type === 'integer') {
    schemaType.type = Number;
  } else if (field.type === 'boolean') {
    schemaType.type = Boolean;
  } else if (field.type === 'array') {
    // Handle Arrays (Simple & Complex)
    if (field.items && field.items.type === 'object') {
      // Recursively process nested objects in arrays
      const nestedSchema = {};
      if (field.items.properties) {
        Object.keys(field.items.properties).forEach(key => {
          nestedSchema[key] = convertType(field.items.properties[key]);
        });
      }
      schemaType.type = [nestedSchema];
    } else if (field.items && field.items.type) {
       // Array of primitives (e.g., strings)
       // We construct a fake field object to get the primitive type
       const innerType = convertType({ type: field.items.type });
       schemaType.type = [innerType.type];
    } else {
      schemaType.type = [mongoose.Schema.Types.Mixed];
    }
  } else if (field.type === 'object') {
     // Handle Nested Objects
     const nestedSchema = {};
     if (field.properties) {
       Object.keys(field.properties).forEach(key => {
         nestedSchema[key] = convertType(field.properties[key]);
       });
     }
     schemaType = nestedSchema; 
     // Note: Mongoose handles nested objects directly, 
     // so we don't wrap it in { type: ... } unless it's Mixed
     return schemaType;
  } else {
    schemaType.type = mongoose.Schema.Types.Mixed;
  }

  // Handle Enums
  if (field.enum) {
    schemaType.enum = field.enum;
  }

  // Handle Defaults
  if (field.default !== undefined) {
    schemaType.default = field.default;
  }

  return schemaType;
};

// 2. Load definitions from JSON files
const modelsPath = path.join(__dirname, 'definitions');
const Models = {};

// Ensure directory exists
if (fs.existsSync(modelsPath)) {
  fs.readdirSync(modelsPath).forEach(file => {
    if (file.endsWith('.json')) {
      try {
        const definition = require(path.join(modelsPath, file));
        const modelName = definition.name || path.parse(file).name;

        // Build the Mongoose Schema object
        const schemaObj = {};
        
        // Base fields that every entity usually needs
        schemaObj.created_date = { type: Date, default: Date.now };
        schemaObj.updated_date = { type: Date, default: Date.now };

        // Map properties
        if (definition.properties) {
          Object.keys(definition.properties).forEach(propName => {
            const fieldDef = definition.properties[propName];
            const mongooseDef = convertType(fieldDef);
            
            // Handle 'required' array from JSON schema
            if (definition.required && definition.required.includes(propName)) {
                if (mongooseDef.type) mongooseDef.required = true;
            }

            schemaObj[propName] = mongooseDef;
          });
        }

        // Create Schema
        // strict: false allows fields NOT in the JSON to still be saved (safer for dev)
        const schema = new mongoose.Schema(schemaObj, { strict: false });
        
        Models[modelName] = mongoose.model(modelName, schema);
        console.log(`✅ Model Loaded: ${modelName}`);
      } catch (err) {
        console.error(`❌ Failed to load model ${file}:`, err.message);
      }
    }
  });
} else {
    console.warn("⚠️ No 'models/definitions' folder found. Create it and add JSON files.");
}

// 3. Manual Fallback for 'User' (Critical for Auth)
// If User.json wasn't uploaded/found, we MUST define it manually 
// or the auth system will crash.
if (!Models.User) {
    console.log("⚠️ 'User' model missing from JSONs. Using Default User Schema.");
    const UserSchema = new mongoose.Schema({
        email: { type: String, required: true, unique: true },
        password: { type: String, required: true },
        full_name: String,
        role: { type: String, default: 'user' },
        tenant_id: String,
        created_date: { type: Date, default: Date.now }
    }, { strict: false });
    Models.User = mongoose.model('User', UserSchema);
}

module.exports = Models;