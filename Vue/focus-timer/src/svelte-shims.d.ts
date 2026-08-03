// Лёгкая ambient-декларация, чтобы редактор не ругался на импорты .svelte.
// Саму проверку типов Svelte здесь не запускаем — достаточно сборки через Vite.
declare module '*.svelte' {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Component: any
  export default Component
}
