/* routes/auth.js */
const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { User, Tenant } = require('../models/SchemaDefinitions');
const auth = require('../middleware/auth'); // Import the middleware created above

// @route   POST api/auth/register
// @desc    Register user & create tenant
// @access  Public
router.post('/register', async (req, res) => {
  const { email, password, full_name, company_name } = req.body;

  try {
    // 1. Check if user exists
    let user = await User.findOne({ email });
    if (user) {
      return res.status(400).json({ msg: 'User already exists' });
    }

    // 2. Create the Tenant (Organization)
    const newTenant = new Tenant({
      name: company_name || `${full_name}'s Workspace`,
      owner_email: email,
      status: 'active',
      subscription_plan: 'free'
    });
    await newTenant.save();

    // 3. Create the User
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    user = new User({
      full_name,
      email,
      password: hashedPassword,
      role: 'owner', // First user is the owner
      tenant_id: newTenant.id.toString(),
      is_super_admin: false
    });

    await user.save();

    // 4. Link User to Tenant as Owner ID
    newTenant.owner_user_id = user.id;
    await newTenant.save();

    // 5. Return JWT
    const payload = {
      user: {
        id: user.id,
        tenant_id: user.tenant_id
      }
    };

    jwt.sign(
      payload,
      process.env.JWT_SECRET,
      { expiresIn: '7d' }, // Token valid for 7 days
      (err, token) => {
        if (err) throw err;
        res.json({ token, user: { id: user.id, email: user.email, full_name: user.full_name, role: user.role, tenant_id: user.tenant_id } });
      }
    );
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server error');
  }
});

// @route   POST api/auth/login
// @desc    Authenticate user & get token
// @access  Public
router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  try {
    // 1. Find User
    let user = await User.findOne({ email });
    if (!user) {
      return res.status(400).json({ msg: 'Invalid Credentials' });
    }

    // 2. Match Password
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(400).json({ msg: 'Invalid Credentials' });
    }

    // 3. Return JWT
    const payload = {
      user: {
        id: user.id,
        tenant_id: user.tenant_id
      }
    };

    jwt.sign(
      payload,
      process.env.JWT_SECRET,
      { expiresIn: '7d' },
      (err, token) => {
        if (err) throw err;
        // Return user data without password
        const userResponse = user.toObject();
        delete userResponse.password;
        res.json({ token, user: userResponse });
      }
    );
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server error');
  }
});

// @route   GET api/auth/me
// @desc    Get logged in user
// @access  Private
router.get('/me', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('-password');
    if (!user) return res.status(404).json({ msg: 'User not found' });
    res.json(user);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

// @route   PUT api/auth/updatedetails
// @desc    Update authenticated user details
// @access  Private
router.put('/updatedetails', auth, async (req, res) => {
  try {
    // 1. Separate password from other data (handle password changes separately for security)
    const { password, ...updateData } = req.body;

    // 2. Update the user
    const user = await User.findByIdAndUpdate(
      req.user.id,
      { $set: updateData },
      { new: true, runValidators: true }
    ).select('-password');

    if (!user) {
      return res.status(404).json({ msg: 'User not found' });
    }

    // 3. Return the updated user
    res.json(user);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});
router.post('/accept-invite', async (req, res) => {
  const { email, password, full_name, tenant_id, role } = req.body;
  try {
    // Check if user exists
    let user = await User.findOne({ email });
    if (user) return res.status(400).json({ msg: 'User already exists' });

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    user = new User({
      email,
      password: hashedPassword,
      full_name,
      tenant_id,
      role: role || 'user',
      is_super_admin: false,
      status: 'active'
    });

    await user.save();
    res.json({ msg: 'User registered successfully' });
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server error');
  }
});
module.exports = router;