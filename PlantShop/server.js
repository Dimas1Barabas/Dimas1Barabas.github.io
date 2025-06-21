const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const cookieParser = require('cookie-parser');

const app = express();
const PORT = 3000;
const JWT_SECRET = 'your_jwt_secret_key';  //      nodemon server.js


mongoose.connect('mongodb://localhost:27017/plantapp', {
  useNewUrlParser: true,
  useUnifiedTopology: true
}).then(() => console.log('MongoDB connected'))
  .catch(err => console.error(err));


const UserSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  email: { type: String, required: true, unique: true },
  passwordHash: { type: String, required: true }
});

const User = mongoose.model('User', UserSchema);


app.use(cors({
  origin: 'https://dimas1barabas.github.io/PlantShop/', 
  credentials: true
}));
app.use(express.json());
app.use(cookieParser());

app.post('/api/register', async (req, res) => {
  const { username, email, password } = req.body;

  if (!username || !email || !password) {
    return res.status(400).json({ message: 'Заполните все поля' });
  }

  const existingUser = await User.findOne({ $or: [{ email }, { username }] });
  if (existingUser) {
    return res.status(400).json({ message: 'Пользователь с таким email или именем уже существует' });
  }

  const passwordHash = await bcrypt.hash(password, 10);

  const user = new User({ username, email, passwordHash });
  await user.save();

  res.json({ message: 'Пользователь зарегистрирован' });
});


app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;

  const user = await User.findOne({ email });
  if (!user) {
    return res.status(400).json({ message: 'Неверный email или пароль' });
  }

  const isPasswordValid = await bcrypt.compare(password, user.passwordHash);
  if (!isPasswordValid) {
    return res.status(400).json({ message: 'Неверный email или пароль' });
  }


  const token = jwt.sign({ userId: user._id, username: user.username }, JWT_SECRET, { expiresIn: '1d' });


  res.cookie('token', token, {
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000 
  });

  res.json({ message: 'Успешный вход', username: user.username });
});


app.get('/api/me', (req, res) => {
  const token = req.cookies.token;

  if (!token) {
    return res.status(401).json({ message: 'Неавторизован' });
  }

  try {
    const data = jwt.verify(token, JWT_SECRET);
    res.json({ username: data.username });
  } catch {
    res.status(401).json({ message: 'Неавторизован' });
  }
});


app.post('/api/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ message: 'Выход выполнен' });
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
