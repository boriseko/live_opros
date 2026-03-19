document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('login-form');
  const input = document.getElementById('password-input');
  const error = document.getElementById('login-error');
  const btn = document.getElementById('login-btn');

  // Check if already authenticated
  fetch('/api/auth/check')
    .then((r) => r.json())
    .then((data) => {
      if (data.authenticated) {
        window.location.href = '/admin.html';
      }
    });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    error.classList.add('hidden');
    btn.disabled = true;
    btn.textContent = 'Вход...';

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: input.value }),
      });

      if (res.ok) {
        window.location.href = '/admin.html';
      } else {
        error.textContent = 'Неверный пароль';
        error.classList.remove('hidden');
        input.value = '';
        input.focus();
      }
    } catch {
      error.textContent = 'Ошибка соединения';
      error.classList.remove('hidden');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Войти';
    }
  });
});
