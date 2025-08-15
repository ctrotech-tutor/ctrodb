// hydrodb/examples/todolist-app/app.js (Final Correct Version)

import { Database, Schema, LogLevel } from '../../src/index.js';

// 1. DEFINE THE SCHEMA
// -------------------------------------------------
const todoSchema = new Schema({
  version: 1,
  collections: {
    todos: {
      fields: {
        text: 'string',
        completed: 'boolean',
        createdAt: 'number',
      },
      indexes: ['completed'],
    },
  },
});

// 2. INITIALIZE THE DATABASE
// -------------------------------------------------
const db = new Database({
  schema: todoSchema,
  dbName: 'HydroListApp_Final', // Use a new clean DB name for the final version
  logLevel: LogLevel.INFO,     // Set to INFO for production-like logging
});
const todosCollection = db.getCollection('todos');

// 3. DOM ELEMENT REFERENCES
// -------------------------------------------------
const form = document.getElementById('todo-form');
const input = document.getElementById('todo-input');
const todoList = document.getElementById('todo-list');
const itemsLeft = document.getElementById('items-left');
const filterButtons = document.getElementById('filter-buttons');
const emptyState = document.getElementById('empty-state');

// 4. APPLICATION STATE
// -------------------------------------------------
let allTodos = []; // A global store for our data
let state = {
  filter: 'all', // 'all', 'active', or 'completed'
};

// 5. RENDER FUNCTION
// -------------------------------------------------
function render() {
  // Always reads from the global `allTodos` store and the `state.filter`
  todoList.innerHTML = '';

  const filteredTodos = allTodos.filter(todo => {
    if (state.filter === 'all') return true;
    if (state.filter === 'active') return !todo.completed;
    if (state.filter === 'completed') return todo.completed;
  });

  emptyState.classList.toggle('hidden', filteredTodos.length > 0);

  const activeCount = allTodos.filter(todo => !todo.completed).length;
  itemsLeft.textContent = `${activeCount} item${activeCount !== 1 ? 's' : ''} left`;

  filteredTodos.forEach(todo => {
    const li = document.createElement('li');
    li.className = 'todo-item animate-add';
    li.dataset.id = todo.id;
    const textClass = todo.completed ? 'todo-text completed' : 'todo-text';
    li.innerHTML = `
      <p class="${textClass}">${todo.text}</p>
      <button class="delete-btn" aria-label="Delete todo">
        <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v6a1 1 0 102 0V8a1 1 0 00-1-1z" clip-rule="evenodd" /></svg>
      </button>
    `;
    todoList.appendChild(li);
  });
}

// 6. EVENT HANDLERS
// -------------------------------------------------
form.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (text) {
    todosCollection.create({ text, completed: false, createdAt: Date.now() });
    input.value = '';
  }
});

todoList.addEventListener('click', (e) => {
  const todoItem = e.target.closest('.todo-item');
  if (!todoItem) return;
  const todoId = Number(todoItem.dataset.id);
  if (e.target.closest('.delete-btn')) {
    todoItem.classList.add('animate-remove');
    todoItem.addEventListener('animationend', () => todosCollection.delete(todoId), { once: true });
  } else {
    todosCollection.find(todoId).then(todo => todo?.update({ completed: !todo.completed }));
  }
});

filterButtons.addEventListener('click', (e) => {
  if (e.target.tagName === 'BUTTON') {
    state.filter = e.target.dataset.filter;
    filterButtons.querySelector('.active').classList.remove('active');
    e.target.classList.add('active');
    render(); // The fix: Just re-render, don't call main()
  }
});

// 7. MAIN EXECUTION
// -------------------------------------------------
async function main() {
  await db.connect();
  // Set up the single, permanent observer
  todosCollection.query().observe(newTodos => {
    allTodos = newTodos.sort((a, b) => a.createdAt - b.createdAt); // Update the global store
    render(); // And re-render the UI
  });
}

// Call main() once to initialize the application
main();
