const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const cookieParser = require('cookie-parser');

const app = express();
const PORT = 3000;
const JWT_SECRET = 'your_jwt_secret_key'; // Замените на сложный ключ

// Подключение к MongoDB
mongoose.connect('mongodb://localhost:27017/plantapp', {
  useNewUrlParser: true,
  useUnifiedTopology: true
}).then(() => console.log('MongoDB connected'))
  .catch(err => console.error(err));

// Модель пользователя
const UserSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  email: { type: String, required: true, unique: true },
  passwordHash: { type: String, required: true }
});

const User = mongoose.model('User', UserSchema);

// Middleware
app.use(cors({
  origin: 'http://localhost:5500', // Адрес вашего фронтенда
  credentials: true
}));
app.use(express.json());
app.use(cookieParser());

// Регистрация
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

// Вход (авторизация)
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

  // Создаём JWT
  const token = jwt.sign({ userId: user._id, username: user.username }, JWT_SECRET, { expiresIn: '1d' });

  // Отправляем токен в httpOnly cookie
  res.cookie('token', token, {
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000 // 1 день
  });

  res.json({ message: 'Успешный вход', username: user.username });
});

// Получить данные текущего пользователя
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

// Выход (удаление куки)
app.post('/api/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ message: 'Выход выполнен' });
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
