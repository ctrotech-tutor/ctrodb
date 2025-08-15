

// hydrodb/examples/hydro-kanban/app.js

import { Database, Schema, LogLevel } from '../../src/index.js';

// 1. --- SCHEMA DEFINITION ---
const kanbanSchema = new Schema({
  version: 1,
  collections: {
    boards: {
      fields: { name: 'string' },
      relations: { columns: { type: 'has_many', collection: 'columns', foreignKey: 'boardId' } }
    },
    columns: {
      fields: { title: 'string', boardId: 'number' },
      indexes: ['boardId'],
      relations: {
        cards: { type: 'has_many', collection: 'cards', foreignKey: 'columnId' },
        board: { type: 'belongs_to', collection: 'boards', foreignKey: 'boardId' }
      }
    },
    cards: {
      fields: { content: 'string', columnId: 'number' },
      indexes: ['columnId'],
      relations: {
        column: { type: 'belongs_to', collection: 'columns', foreignKey: 'columnId' }
      }
    }
  }
});

// 2. --- DATABASE INITIALIZATION ---
const db = new Database({
  schema: kanbanSchema,
  dbName: 'HydroKanbanDB',
  logLevel: LogLevel.INFO,
});
const boardsCollection = db.getCollection('boards');
const columnsCollection = db.getCollection('columns');
const cardsCollection = db.getCollection('cards');

// 3. --- DOM ELEMENT REFERENCES ---
const boardTitleEl = document.getElementById('board-title');
const kanbanBoardEl = document.getElementById('kanban-board');
const addColumnBtn = document.getElementById('add-column-btn');
const addColumnModal = document.getElementById('add-column-modal');
const addColumnForm = document.getElementById('add-column-form');
const cancelAddColumnBtn = document.getElementById('cancel-add-column');
const newColumnTitleInput = document.getElementById('new-column-title');

// 4. --- DRAG & DROP STATE ---
let draggedCardId = null;

// 5. --- RENDER FUNCTIONS ---
function renderCard(card) {
  const cardEl = document.createElement('div');
  cardEl.className = 'card p-3 bg-gray-700 rounded-md shadow-sm cursor-grab animate-add';
  cardEl.setAttribute('draggable', 'true');
  cardEl.dataset.cardId = card.id;
  cardEl.textContent = card.content;
  return cardEl;
}

function renderColumn(column, cards) {
  const columnEl = document.createElement('div');
  columnEl.className = 'column w-72 bg-gray-800 rounded-lg shadow-md flex flex-col flex-shrink-0';
  columnEl.dataset.columnId = column.id;

  columnEl.innerHTML = `
    <h3 class="font-bold p-3 text-lg border-b border-gray-700">${column.title}</h3>
    <div class="card-list p-2 space-y-2 overflow-y-auto flex-1"></div>
    <button class="add-card-btn p-3 text-gray-400 hover:text-white w-full transition-colors">+ Add a card</button>
  `;

  const cardListEl = columnEl.querySelector('.card-list');
  cards.forEach(card => cardListEl.appendChild(renderCard(card)));

  return columnEl;
}

async function renderBoard(board) {
  boardTitleEl.textContent = board.name;
  kanbanBoardEl.innerHTML = '';

  // Use our 'columns' relation to get the columns for this board
  const columns = await board.columns.fetch();

  for (const column of columns) {
    // For each column, use its 'cards' relation to get its cards
    const cards = await column.cards.fetch();
    const columnEl = renderColumn(column, cards);
    kanbanBoardEl.appendChild(columnEl);
  }
}

// 6. --- EVENT HANDLERS ---
function setupEventListeners(board) {
  // Add Column
  addColumnBtn.onclick = () => addColumnModal.classList.remove('hidden');
  cancelAddColumnBtn.onclick = () => addColumnModal.classList.add('hidden');
  addColumnForm.onsubmit = async (e) => {
    e.preventDefault();
    const title = newColumnTitleInput.value.trim();
    if (title) {
      await columnsCollection.create({ title, boardId: board.id });
      newColumnTitleInput.value = '';
      addColumnModal.classList.add('hidden');
    }
  };

  // Event delegation for adding cards and drag-drop
  kanbanBoardEl.onclick = async (e) => {
    if (e.target.classList.contains('add-card-btn')) {
      const columnId = Number(e.target.closest('.column').dataset.columnId);
      const content = prompt('Enter card content:');
      if (content) {
        await cardsCollection.create({ content, columnId });
      }
    }
  };

  // Drag and Drop Handlers
  kanbanBoardEl.ondragstart = (e) => {
    if (e.target.classList.contains('card')) {
      draggedCardId = Number(e.target.dataset.cardId);
      e.target.classList.add('dragging');
    }
  };

  kanbanBoardEl.ondragover = (e) => {
    e.preventDefault();
    const columnEl = e.target.closest('.column');
    if (columnEl) {
      columnEl.classList.add('drag-over');
    }
  };

  kanbanBoardEl.ondragleave = (e) => {
    const columnEl = e.target.closest('.column');
    if (columnEl) {
      columnEl.classList.remove('drag-over');
    }
  };

  kanbanBoardEl.ondrop = async (e) => {
    e.preventDefault();
    const columnEl = e.target.closest('.column');
    if (columnEl && draggedCardId) {
      const newColumnId = Number(columnEl.dataset.columnId);
      const card = await cardsCollection.find(draggedCardId);
      if (card && card.columnId !== newColumnId) {
        await card.update({ columnId: newColumnId });
      }
    }
    // Cleanup
    document.querySelectorAll('.column').forEach(c => c.classList.remove('drag-over'));
  };
  
  kanbanBoardEl.ondragend = (e) => {
    if (e.target.classList.contains('card')) {
      e.target.classList.remove('dragging');
    }
    draggedCardId = null;
  };
}

// 7. --- MAIN EXECUTION ---
async function main() {
  await db.connect();

  // Find the main board or create it if it doesn't exist
  let mainBoard = await boardsCollection.query().first();
  if (!mainBoard) {
    mainBoard = await boardsCollection.create({ name: 'My First Board' });
    const todoCol = await columnsCollection.create({ title: 'To Do', boardId: mainBoard.id });
    await columnsCollection.create({ title: 'In Progress', boardId: mainBoard.id });
    await columnsCollection.create({ title: 'Done', boardId: mainBoard.id });
    await cardsCollection.create({ content: 'Welcome to HydroKanban!', columnId: todoCol.id });
  }

  // The CORE of the reactive app: Observe the entire database for any change.
  // A simple but powerful approach for this app.
  db.emitter.on('change', () => renderBoard(mainBoard));

  // Initial render and setup
  await renderBoard(mainBoard);
  setupEventListeners(mainBoard);
}

main();
