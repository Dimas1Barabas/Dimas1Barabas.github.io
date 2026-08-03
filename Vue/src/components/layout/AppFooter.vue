<script setup lang="ts">
// Простой футер.
</script>

<template>
  <footer class="footer">
    <div class="container footer__inner">
      <span>TaskFlow — учебный проект на Vue 3 + TS</span>
      <a
        class="footer__link"
        href="https://github.com/Dimas1Barabas/Dimas1Barabas.github.io"
        target="_blank"
        rel="noopener"
      >
        GitHub ↗
      </a>
    </div>
  </footer>
</template>

<style scoped>
.footer {
  margin-top: auto;
  padding: 1.25rem 0;
  border-top: 1px solid var(--border);
  background: var(--surface);
}
.footer__inner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  font-size: 0.85rem;
  color: var(--text-muted);
}
.footer__link {
  font-weight: 600;
}
.footer__link:hover {
  color: var(--primary);
}
</style>
