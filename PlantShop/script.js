    
document.addEventListener("DOMContentLoaded", function() {
  // Получаем элементы DOM
  const openModalBtn = document.getElementById('openModalBtn');
  const modal = document.getElementById('modal');
  const closeModalBtn = document.getElementById('closeModalBtn');
  const tabButtons = document.querySelectorAll('.tab-button');
  const tabContents = document.querySelectorAll('.tab-content');
  const registerForm = document.querySelector('#register form'); 
  const loginForm = document.querySelector('#login form'); 
  const logoutButton = document.createElement('button'); 
  logoutButton.id = 'logout-button';
  logoutButton.style.display = 'none'; 
  logoutButton.textContent = 'Выйти';


  
  openModalBtn.addEventListener('click', () => {
    const username = localStorage.getItem('username');
    if (!username) {
      modal.style.display = 'block'; 
    } else {
    
      userNameDisplay.textContent = username;
      userEmailDisplay.textContent = localStorage.getItem('email') || 'user@example.com';
      userStatusDisplay.textContent = 'Активен';

      const orders = [
        { id: 1, item: 'Роза', status: 'Доставлен' },
        { id: 2, item: 'Кактус', status: 'В обработке' }
      ];
      userOrdersList.innerHTML = '';
      orders.forEach(order => {
        const li = document.createElement('li');
        li.textContent = `Заказ #${order.id}: ${order.item} - ${order.status}`;
        userOrdersList.appendChild(li);
      });

      userModal.classList.remove('hidden');
      userModal.style.display = 'block';
    }
  });

  
  closeModalBtn.addEventListener('click', () => {
    modal.style.display = 'none';
  });

  
  window.addEventListener('click', (event) => {
    if (event.target === modal) {
      modal.style.display = 'none';
    }
    if (event.target === userModal) {
        userModal.classList.add('hidden');
      userModal.style.display = 'none';
    }
  });

  
  tabButtons.forEach(button => {
    button.addEventListener('click', () => {
      const tab = button.getAttribute('data-tab');
      tabButtons.forEach(btn => btn.classList.remove('active'));
      tabContents.forEach(content => content.classList.remove('active'));
      button.classList.add('active');
      document.getElementById(tab).classList.add('active');
    });
  });

  
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

  
  function updateUserButton(username) {
    openModalBtn.textContent = username;
    openModalBtn.disabled = false;
    logoutButton.style.display = 'inline'; 
    localStorage.setItem('username', username); 
  }

  // Добавляем модальное окно пользователя с кнопкой "Выйти" внутри
  const userModal = document.createElement('div');
  userModal.id = 'userModal';
  userModal.className = 'modal hidden';
  userModal.innerHTML = `
    <div class="modal-content user-content">
      <span id="closeUserModal" class="close">&times;</span>
      <h2>Пользователь</h2>
      <div id="userInfo">
        <p><strong>Имя:</strong> <span id="userNameDisplay"></span></p>
        <p><strong>Email:</strong> <span id="userEmailDisplay"></span></p>
        <h3>Заказы</h3>
        <ul id="userOrdersList"></ul>
        <p><strong>Статус:</strong> <span id="userStatusDisplay"></span></p>
        <button id="logout-button" type="button">Выйти</button>
      </div>
    </div>
  `;
  document.body.appendChild(userModal);

  const userNameDisplay = document.getElementById('userNameDisplay');
  const userEmailDisplay = document.getElementById('userEmailDisplay');
  const userOrdersList = document.getElementById('userOrdersList');
  const userStatusDisplay = document.getElementById('userStatusDisplay');
  const closeUserModal = document.getElementById('closeUserModal');

  openModalBtn.addEventListener('click', () => {
    const username = localStorage.getItem('username');
    if (username) {
      // Заполняем данные пользователя (здесь можно заменить на реальные данные)
      userNameDisplay.textContent = username;
      userEmailDisplay.textContent = localStorage.getItem('email') || 'user@example.com';
      userStatusDisplay.textContent = 'Активен';

      // Пример заказов
      const orders = [
        { id: 1, item: 'Роза', status: 'Доставлен' },
        { id: 2, item: 'Кактус', status: 'В обработке' }
      ];
      userOrdersList.innerHTML = '';
      orders.forEach(order => {
        const li = document.createElement('li');
        li.textContent = `Заказ #${order.id}: ${order.item} - ${order.status}`;
        userOrdersList.appendChild(li);
      });

      userModal.classList.remove('hidden');
      userModal.style.display = 'block';
    }
  });

  closeUserModal.addEventListener('click', () => {
    userModal.classList.add('hidden');
    userModal.style.display = 'none';
  });

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
  document.getElementById('logout-button').addEventListener('click', async () => {
    try {
      const response = await fetch('http://localhost:3000/api/logout', {
        method: 'POST'
      });

      if (response.ok) {
        openModalBtn.textContent = 'Войти'; // Меняем текст кнопки на "Войти" после выхода
        openModalBtn.disabled = false; // Делаем кнопку активной
        // Скрываем модальное окно пользователя после выхода
        userModal.classList.add('hidden');
        userModal.style.display = 'none';
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
