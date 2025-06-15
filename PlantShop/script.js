
document.addEventListener("DOMContentLoaded", function() {
  // Получаем элементы DOM
  const openModalBtn = document.getElementById('openModalBtn');
  const modal = document.getElementById('modal');
  const closeModalBtn = document.getElementById('closeModalBtn');
  const tabButtons = document.querySelectorAll('.tab-button');
  const tabContents = document.querySelectorAll('.tab-content');
  const registerForm = document.querySelector('#register form'); // Форма регистрации
  const loginForm = document.querySelector('#login form'); // Форма входа
  const logoutButton = document.createElement('button'); // Создаем кнопку "Выйти"
  logoutButton.id = 'logout-button';
  logoutButton.style.display = 'none'; // Скрываем кнопку
  logoutButton.textContent = 'Выйти';

  // Добавляем кнопку "Выйти" в header
  const headerNav = document.querySelector('header nav'); // Находим nav
  headerNav.parentNode.insertBefore(logoutButton, headerNav.nextSibling); // Вставляем кнопку после nav

  // Функция для открытия модального окна
  openModalBtn.addEventListener('click', () => {
    modal.style.display = 'block';
  });

  // Функция для закрытия модального окна
  closeModalBtn.addEventListener('click', () => {
    modal.style.display = 'none';
  });

  // Закрытие модального окна при клике вне его
  window.addEventListener('click', (event) => {
    if (event.target === modal) {
      modal.style.display = 'none';
    }
  });

  // Переключение вкладок
  tabButtons.forEach(button => {
    button.addEventListener('click', () => {
      const tab = button.getAttribute('data-tab');
      tabButtons.forEach(btn => btn.classList.remove('active'));
      tabContents.forEach(content => content.classList.remove('active'));
      button.classList.add('active');
      document.getElementById(tab).classList.add('active');
    });
  });

  // Обработчик отправки формы регистрации
  registerForm.addEventListener('submit', async (e) => {
    e.preventDefault(); // Предотвращаем перезагрузку страницы

    const username = document.getElementById('reg-username').value;
    const email = document.getElementById('reg-email').value;
    const password = document.getElementById('reg-password').value;

    try {
      const result = await postData('http://localhost:3000/api/register', { username, email, password });
      alert(result.message); // Показываем сообщение с сервера

      // Если регистрация прошла успешно, переключаемся на вкладку входа
      if (result.message === 'Пользователь зарегистрирован') {
        document.querySelector('.tab-button[data-tab="login"]').click();
      }
    } catch (error) {
      console.error('Ошибка при регистрации:', error);
      alert('Ошибка при регистрации');
    }
  });

  // Обработчик отправки формы входа
  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault(); // Предотвращаем перезагрузку страницы

    const email = document.getElementById('login-email').value;
    const password = document.getElementById('login-password').value;

    try {
      const result = await postData('http://localhost:3000/api/login', { email, password });
      alert(result.message); // Показываем сообщение с сервера

      if (result.message === 'Успешный вход') {
        modal.style.display = 'none'; // Закрываем модальное окно
        updateUserButton(result.username); // Обновляем кнопку с именем пользователя
      }
    } catch (error) {
      console.error('Ошибка при входе:', error);
      alert('Ошибка при входе');
    }
  });

  // Обновление кнопки в header с именем пользователя и отображение кнопки выхода
  function updateUserButton(username) {
    openModalBtn.textContent = username;
    openModalBtn.disabled = true;
    logoutButton.style.display = 'inline'; // Делаем кнопку "Выйти" видимой
    localStorage.setItem('username', username); // Сохраняем в localStorage
  }

  // Проверка авторизации при загрузке страницы
  async function checkAuth() {
    try {
      const response = await fetch('http://localhost:3000/api/me', {
        credentials: 'include'
      });

      if (response.ok) {
        const data = await response.json();
        updateUserButton(data.username);
      } else {
        const storedUsername = localStorage.getItem('username');
        if (storedUsername) {
          updateUserButton(storedUsername);
        }
      }
    } catch (error) {
      console.error('Ошибка при проверке авторизации:', error);
      const storedUsername = localStorage.getItem('username');
      if (storedUsername) {
        updateUserButton(storedUsername);
      }
    }
  }

  // Обработчик кнопки "Выйти"
  logoutButton.addEventListener('click', async () => {
    try {
      const response = await fetch('http://localhost:3000/api/logout', {
        method: 'POST'
      });

      if (response.ok) {
        openModalBtn.textContent = 'Check out(0)'; // Возвращаем текст кнопки по умолчанию
        openModalBtn.disabled = false; // Делаем кнопку активной
        logoutButton.style.display = 'none'; // Скрываем кнопку "Выйти"
        localStorage.removeItem('username'); // Удаляем имя пользователя из localStorage
        checkAuth(); // Обновляем отображение
      } else {
        console.error('Ошибка при выходе');
      }
    } catch (error) {
      console.error('Ошибка при выходе', error);
    }
  });

  // Функция для отправки данных на сервер
  async function postData(url = '', data = {}) {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(data)
    });

    if (!response.ok) {
      const message = `Ошибка HTTP: ${response.status}`;
      throw new Error(message);
    }

    return response.json();
  }

  // Запускаем проверку авторизации при загрузке страницы
  checkAuth();
});
