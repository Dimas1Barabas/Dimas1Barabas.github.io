class Todo {
  selectors = {
    root: '[data-js-todo]',
    newTaskForm: '[data-js-todo-new-task-form]',
    newTaskInput: '[data-js-todo-new-task-input]',
    searchTaskForm: '[data-js-todo-search-task-form]',
    searchTaskInput: '[data-js-todo-search-task-input]',
    totalTasks: '[data-js-todo-total-tasks]',
    deleteAllButton: '[data-js-todo-delete-all-button]',
    filterButtons: '[data-js-todo-filter]',
    list: '[data-js-todo-list]',
    item: '[data-js-todo-item]',
    itemCheckbox: '[data-js-todo-item-checkbox]',
    itemLabel: '[data-js-todo-item-label]',
    itemEditButton: '[data-js-todo-item-edit-button]',
    itemEditInput: '[data-js-todo-item-edit-input]',
    itemDeleteButton: '[data-js-todo-item-delete-button]',
    emptyMessage: '[data-js-todo-empty-message]',
  }
  
  stateClasses = {
    isVisible: 'is-visible',
    isDisappearing: 'is-disappearing',
    filterActive: 'active',
    isEditing: 'is-editing'
  }
  
  localStorageKey = 'todo-items'
  
  constructor() {
    this.rootElement = document.querySelector(this.selectors.root);
    this.newTaskFormElement = this.rootElement.querySelector(this.selectors.newTaskForm)
    this.newTaskInputElement = this.rootElement.querySelector(this.selectors.newTaskInput)
    this.searchTaskFormElement = this.rootElement.querySelector(this.selectors.searchTaskForm)
    this.searchTaskInputElement = this.rootElement.querySelector(this.selectors.searchTaskInput)
    this.totalTasksElement = this.rootElement.querySelector(this.selectors.totalTasks)
    this.deleteAllButtonElement = this.rootElement.querySelector(this.selectors.deleteAllButton)
    this.filterButtonsElements = this.rootElement.querySelectorAll(this.selectors.filterButtons)
    this.listElement = this.rootElement.querySelector(this.selectors.list)
    this.emptyMessageElement = this.rootElement.querySelector(this.selectors.emptyMessage)
    
    this.state = {
      items: this.getItemsFormLocalStorage(),
      filteredItems: null,
      searchQuery: '',
      filterType: 'all',
      editingItemId: null,
    }
    
    this.render()
    this.bindEvents()
  }
  
  getItemsFormLocalStorage() {
    const rowData = localStorage.getItem(this.localStorageKey)
    if (!rowData) return []
    
    try {
      const parsedData = JSON.parse(rowData)
      return Array.isArray(parsedData) ? parsedData : []
    } catch {
      console.error('Todo items parse error')
      return []
    }
  }
  
  saveItemsToLocalStorage() {
    localStorage.setItem(this.localStorageKey, JSON.stringify(this.state.items))
  }
  
  setActiveFilterButton(filterType) {
    this.filterButtonsElements.forEach(button => {
      button.classList.toggle(
        this.stateClasses.filterActive,
        button.dataset.jsTodoFilter === filterType
      )
    })
  }
  
  refreshFilter() {
    if (this.state.filterType === 'all' && !this.state.searchQuery.trim()) {
      this.state.filteredItems = null
    } else {
      this.filter()
    }
    this.render()
  }
  
  startEditing(id, title) {
    this.state.editingItemId = id
    
    this.refreshFilter()
    
    requestAnimationFrame(() => {
      const editInput = this.rootElement.querySelector(`[data-js-todo-item-edit-input="${id}"]`)
      if (editInput) {
        editInput.focus()
        editInput.select()
      }
    })
  }
  
  
  stopEditing() {
    this.state.editingItemId = null
    this.refreshFilter()
  }
  
  updateItemTitle(id, newTitle) {
    if (newTitle.trim().length === 0) {
      this.stopEditing()
      return
    }
    
    this.state.items = this.state.items.map(item =>
      item.id === id ? { ...item, title: newTitle.trim() } : item
    )
    this.saveItemsToLocalStorage()
    this.stopEditing()
  }
  
  filter() {
    const itemsToFilter = [...this.state.items] 
    
    let filtered = itemsToFilter
    
    if (this.state.filterType === 'active') {
      filtered = filtered.filter(item => !item.isChecked)
    } else if (this.state.filterType === 'completed') {
      filtered = filtered.filter(item => item.isChecked)
    }
    
    if (this.state.searchQuery.trim()) {
      const queryFormatted = this.state.searchQuery.toLowerCase()
      filtered = filtered.filter(({ title }) =>
        title.toLowerCase().includes(queryFormatted)
      )
    }
    
    this.state.filteredItems = filtered
  }
  
  setFilter(filterType) {
    this.state.filterType = filterType
    this.refreshFilter()
    this.setActiveFilterButton(filterType)
  }
  
  resetFilter() {
    this.state.filteredItems = null
    this.state.searchQuery = ''
    this.state.filterType = 'all'
    this.state.editingItemId = null
    this.setActiveFilterButton('all')
    this.render()
  }
  
  render() {
    this.totalTasksElement.textContent = this.state.items.length
    
    this.deleteAllButtonElement.classList.toggle(
      this.stateClasses.isVisible,
      this.state.items.length > 0
    )
    
    const items = this.state.filteredItems ?? this.state.items
    
    this.listElement.innerHTML = items.map(({ id, title, isChecked }) => {
      const isEditing = this.state.editingItemId === id
      return `
        <li class="todo__item todo-item ${isEditing ? 'todo-item--editing' : ''}" data-js-todo-item="${id}">
          <input
            class="todo-item__checkbox"
            id="${id}"
            type="checkbox"
            ${isChecked ? 'checked' : ''}
            data-js-todo-item-checkbox
          >
          ${isEditing ? `
            <input
              class="todo-item__edit-input"
              data-js-todo-item-edit-input="${id}"
              value="${title}"
            >
          ` : `
            <p class="todo-item__label" data-js-todo-item-label>
              ${title}
            </p>
          `}
          ${!isEditing ? `
            <button
              class="todo-item__edit-button"
              type="button"
              title="Редактировать"
              data-js-todo-item-edit-button="${id}"
            >
              Изменить
            </button>
          ` : ''}
          <button
            class="todo-item__delete-button"
            type="button"
            aria-label="Delete"
            title="Delete"
            data-js-todo-item-delete-button
          >
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M15 5L5 15M5 5L15 15" stroke="#757575" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </button>
        </li>
      `
    }).join('')
    
    const isEmptyFilteredItems = !!(this.state.filteredItems && this.state.filteredItems.length === 0)
    const isEmptyItems = this.state.items.length === 0
    
    this.emptyMessageElement.textContent =
      isEmptyFilteredItems ? 'Задача не найдена'
        : isEmptyItems ? 'Пока нет задач'
          : ''
  }
  
  addItem(title) {
    this.state.items.push({
      id: crypto?.randomUUID() ?? Date.now().toString(),
      title: title,
      isChecked: false,
    })
    this.saveItemsToLocalStorage()
    this.refreshFilter()
  }
  
  deleteItem(id) {
    this.state.items = this.state.items.filter((item) => item.id !== id)
    if (this.state.editingItemId === id) {
      this.stopEditing()
    } else {
      this.refreshFilter()
    }
    this.saveItemsToLocalStorage()
  }
  
  toggleCheckedState(id) {
    this.state.items = this.state.items.map((item) => {
      if (item.id === id) {
        return { ...item, isChecked: !item.isChecked }
      }
      return item
    })
    this.saveItemsToLocalStorage()
    this.refreshFilter()
  }
  
  onNewTaskFormSubmit = (event) => {
    event.preventDefault()
    const newTodoItemTitle = this.newTaskInputElement.value
    if (newTodoItemTitle.trim().length > 0) {
      this.addItem(newTodoItemTitle)
      this.resetFilter()
      this.newTaskInputElement.value = ''
      this.newTaskInputElement.focus()
    }
  }
  
  onSearchTaskFormSubmit = (event) => {
    event.preventDefault()
  }
  
  onSearchTaskInputChange = ({ target }) => {
    const value = target.value.trim()
    this.state.searchQuery = value
    this.refreshFilter()
  }
  
  onFilterButtonClick = ({ target }) => {
    if (target.matches(this.selectors.filterButtons)) {
      this.setFilter(target.dataset.jsTodoFilter)
    }
  }
  
  onEditButtonClick = ({ target }) => {
    if (target.matches(this.selectors.itemEditButton)) {
      const itemId = target.dataset.jsTodoItemEditButton
      const item = this.state.items.find(item => item.id === itemId)
      if (item) {
        this.startEditing(itemId, item.title)
      }
    }
  }
  
  onEditInputBlur = ({ target }) => {
    if (target.matches(this.selectors.itemEditInput)) {
      const itemId = target.dataset.jsTodoItemEditInput
      const newTitle = target.value.trim()
      this.updateItemTitle(itemId, newTitle)
    }
  }
  
  onEditInputKeydown = ({ target, key }) => {
    if (target.matches(this.selectors.itemEditInput)) {
      const itemId = target.dataset.jsTodoItemEditInput
      if (key === 'Enter') {
        const newTitle = target.value.trim()
        this.updateItemTitle(itemId, newTitle)
      } else if (key === 'Escape') {
        this.stopEditing()
      }
    }
  }
  
  onDeleteAllButtonClick = () => {
    const isConfirmed = confirm('Are you sure you want to delete all?')
    if (isConfirmed) {
      this.state.filteredItems = null
      this.searchTaskInputElement.value = ''
      this.state.items = []
      this.state.editingItemId = null
      this.saveItemsToLocalStorage()
      this.resetFilter()
    }
  }
  
  onClick = ({ target }) => {
    if (target.matches(this.selectors.itemDeleteButton)) {
      const itemElement = target.closest(this.selectors.item)
      const itemCheckboxElement = itemElement.querySelector(this.selectors.itemCheckbox)
      itemElement.classList.add(this.stateClasses.isDisappearing)
      setTimeout(() => this.deleteItem(itemCheckboxElement.id), 400)
    }
  }
  
  onChange = ({ target }) => {
    if (target.matches(this.selectors.itemCheckbox)) {
      this.toggleCheckedState(target.id)
    }
  }
  
  bindEvents() {
    this.newTaskFormElement.addEventListener('submit', this.onNewTaskFormSubmit)
    this.searchTaskFormElement.addEventListener('submit', this.onSearchTaskFormSubmit)
    this.searchTaskInputElement.addEventListener('input', this.onSearchTaskInputChange)
    this.rootElement.addEventListener('click', this.onFilterButtonClick)
    this.rootElement.addEventListener('click', this.onEditButtonClick)
    this.rootElement.addEventListener('blur', this.onEditInputBlur, true)
    this.rootElement.addEventListener('keydown', this.onEditInputKeydown, true)
    this.deleteAllButtonElement.addEventListener('click', this.onDeleteAllButtonClick)
    this.listElement.addEventListener('click', this.onClick)
    this.listElement.addEventListener('change', this.onChange)
  }
}

new Todo()
