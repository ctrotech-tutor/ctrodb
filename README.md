# 💧 CtroDB: The Reactive JavaScript Database

[![NPM Version](https://img.shields.io/npm/v/ctrodb.svg)](https://www.npmjs.com/package/ctrodb)
[![License: MIT](https://img.shields.io/npm/l/ctrodb.svg)](https://opensource.org/licenses/MIT)
[![Build Status](https://img.shields.io/github/actions/workflow/status/ctrotech-tutor/ctrodb/main.yml?branch=main)](https://github.com/ctrotech-tutor/ctrodb/actions)
[![Minified Size](https://img.shields.io/bundlephobia/min/ctrodb.svg)](https://bundlephobia.com/result?p=ctrodb)

**CtroDB is a modern, high-performance, and reactive client-side database from Ctrotech. Built with zero dependencies and based on Ctrotech Tutor insights, it provides a structured, relational-like API on top of the browser's native IndexedDB, giving you the best of both worlds: performance and developer experience.**

Stop fighting with `localStorage` and `IndexedDB`'s raw API. CtroDB makes it easy to build complex, data-driven applications that feel incredibly fast and responsive.

---

## Table of Contents

- [Why CtroDB?](#why-ctrodb)
- [Key Features](#-key-features)
- [Environments](#-environments)
- [Installation & Usage](#-installation--usage)
  - [1. Using with NPM (Recommended)](#1-using-with-npm-recommended)
  - [2. Using in the Browser with `<script>`](#2-using-in-the-browser-with-script)
- [Core Concepts](#-core-concepts)
  - [The Schema](#the-schema)
  - [The Database](#the-database)
  - [Collections & Models](#collections--models)
  - [Queries](#queries)
  - [Reactivity with `observe()`](#reactivity-with-observe)
- [Advanced Usage](#-advanced-usage)
  - [Relational Queries](#relational-queries)
  - [Complex `OR` Queries](#complex-or-queries)
  - [Debugging](#debugging)
- [Contributing](#-contributing)
- [License](#️-license)

---

## Why CtroDB?

| Problem with Traditional Tools | How CtroDB Solves It |
| :--- | :--- |
| **`localStorage` is slow & blocking.** | CtroDB is fully asynchronous and non-blocking, ensuring a smooth UI. |
| **`IndexedDB` API is complex & verbose.** | CtroDB provides a clean, modern, and chainable API that is a joy to use. |
| **Managing data relationships is hard.** | CtroDB has built-in support for `has_many` and `belongs_to` relations. |
| **Keeping UI in sync with data is messy.** | The `.observe()` method provides effortless, fine-grained reactivity out of the box. |
| **No clear structure or schema.** | CtroDB is schema-driven, ensuring data consistency and enabling migrations. |

## ✨ Key Features

*   **🚀 Super Fast:** Built to be highly performant, using indexed queries and key ranges to retrieve data in milliseconds.
*   **💧 Reactive and Live:** Use `.observe()` on any query to get live updates in your UI.
*   **🔗 Model Relations:** Define `has_many` and `belongs_to` relationships between your data collections.
*   **🛠️ Clean, Modern API:** A fluent, intuitive API with expressive queries like `.where('field', '>', value)` and `.orWhere(...)`.
*   **📦 Multi-Environment Support:** Works seamlessly in Node.js, with modern bundlers (Vite, Webpack), and directly in the browser via a `<script>` tag.
*   **🪶 Zero Dependencies:** Written in plain, modern JavaScript, making it lightweight, transparent, and secure.
*   **🐛 Built-in Debugging:** A configurable, level-based logger to help you diagnose issues and understand data flow.

## 🌍 Environments

CtroDB is built to be universal and works in any modern JavaScript environment.

| Environment | Support | How to Use |
| :--- | :--- | :--- |
| **Modern Bundlers** (Vite, Webpack) | ✅ **Yes** | `import { Database } from 'ctrodb';` |
| **Node.js** | ✅ **Yes** | `const { Database } = require('ctrodb');` |
| **Browser `<script>` Tag** | ✅ **Yes** | `<script src=".../ctrodb.umd.js"></script>` |

## 📦 Installation & Usage

### 1. Using with NPM (Recommended)

Install the package using your favorite package manager:

```bash
npm install ctrodb
```

Then, import it into your project:

```javascript
import { Database, Schema, LogLevel } from 'ctrodb';

// 1. Define your schema
const mySchema = new Schema({
  version: 1,
  collections: {
    posts: {
      fields: { title: 'string', rating: 'number' },
      indexes: ['rating'],
    },
  },
});

// 2. Initialize and connect to the database
const db = new Database({
  schema: mySchema,
  dbName: 'MyWebAppDB',
  logLevel: LogLevel.INFO,
});
await db.connect();

// 3. Query your data
const topPosts = await db.getCollection('posts').query()
  .where('rating', '>=', 5)
  .fetch();
```

### 2. Using in the Browser with `<script>`

For simple projects or environments without a build step, you can use the UMD build.

1.  Download the latest `ctrodb.umd.js` file from the [Releases page](https://github.com/ctrotech-tutor/ctrodb/releases) on GitHub or use a CDN like [unpkg](https://unpkg.com/ctrodb/dist/ctrodb.umd.js).
2.  Include it in your HTML file.

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>CtroDB - UMD Example</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 2rem auto; background-color: #f9fafb; }
    .container { background-color: #fff; padding: 2rem; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); }
    h1 { color: #1a202c; }
    input[type="text"] { width: 70%; padding: 0.75rem; border: 1px solid #cbd5e0; border-radius: 4px; font-size: 1rem; }
    button { padding: 0.75rem 1rem; border: none; border-radius: 4px; color: #fff; background-color: #4299e1; cursor: pointer; font-size: 1rem; margin-left: 0.5rem; }
    button:hover { background-color: #2b6cb0; }
    ul { list-style: none; padding: 0; margin-top: 1.5rem; }
    li { display: flex; align-items: center; justify-content: space-between; padding: 0.75rem; background-color: #edf2f7; border-radius: 4px; margin-bottom: 0.5rem; }
    li.completed span { text-decoration: line-through; color: #a0aec0; }
    li button { background-color: #e53e3e; font-size: 0.8rem; padding: 0.25rem 0.5rem; }
    li button:hover { background-color: #c53030; }
  </style>
</head>
<body>

  <div class="container">
    <h1>My Todo List (Powered by CtroDB)</h1>
    <div>
      <input type="text" id="todo-input" placeholder="What needs to be done?">
      <button id="add-todo-btn">Add</button>
    </div>
    <ul id="todo-list"></ul>
  </div>

  <!-- 1. Load the CtroDB library from a CDN -->
  <script src="https://unpkg.com/ctrodb/dist/ctrodb.umd.js"></script>

  <script>
    // 2. CtroDB is now available as a global variable!
    const { Database, Schema, LogLevel } = window.CtroDB;

    // UI Elements
    const todoInput = document.getElementById('todo-input');
    const addTodoBtn = document.getElementById('add-todo-btn');
    const todoList = document.getElementById('todo-list');

    // 3. Define the schema for our 'todos' collection
    const todoSchema = new Schema({
      version: 1,
      collections: {
        todos: {
          fields: {
            text: 'string',
            completed: 'boolean',
            createdAt: 'number'
          },
          indexes: ['createdAt'] // Index for sorting
        }
      }
    });

    // 4. Initialize the database
    const db = new Database({
      schema: todoSchema,
      dbName: 'DetailedExampleDB',
      logLevel: LogLevel.NONE // Set to INFO or DEBUG to see logs
    });

    // Main application logic
    async function main() {
      await db.connect();
      const todos = db.getCollection('todos');

      // 5. This is the core of the app: A REACTIVE RENDERER
      // We observe the entire collection, sorted by creation time.
      // This function will run automatically whenever the data changes.
      todos.query().observe(allTodos => {
        const sortedTodos = allTodos.sort((a, b) => a.createdAt - b.createdAt);
        
        todoList.innerHTML = ''; // Clear the current list
        
        sortedTodos.forEach(todo => {
          const li = document.createElement('li');
          li.className = todo.completed ? 'completed' : '';
          
          const span = document.createElement('span');
          span.textContent = todo.text;
          // Click the text to toggle completion status
          span.style.cursor = 'pointer';
          span.onclick = () => todo.update({ completed: !todo.completed });
          
          const deleteBtn = document.createElement('button');
          deleteBtn.textContent = 'Delete';
          // Click the button to delete the todo
          deleteBtn.onclick = () => todo.delete();
          
          li.appendChild(span);
          li.appendChild(deleteBtn);
          todoList.appendChild(li);
        });
      });

      // 6. Handle adding new todos
      const addTodo = async () => {
        const text = todoInput.value.trim();
        if (text) {
          await todos.create({
            text: text,
            completed: false,
            createdAt: Date.now()
          });
          todoInput.value = ''; // Clear the input
          todoInput.focus();
        }
      };

      addTodoBtn.onclick = addTodo;
      todoInput.onkeyup = (event) => {
        if (event.key === 'Enter') {
          addTodo();
        }
      };
    }

    // Run the application
    main();
  </script>

</body>
</html>

```

## 🧠 Core Concepts

### The Schema
The `Schema` is the blueprint for your database. It defines the version, the collections (tables), and the fields, indexes, and relations within them. A well-defined schema is the key to a robust application. Incrementing the `version` number is how you trigger database migrations.

```javascript
const blogSchema = new Schema({
  version: 1,
  collections: {
    posts: {
      fields: { title: 'string', content: 'string', publishedAt: 'number' },
      indexes: ['publishedAt'], // For fast lookups on the 'publishedAt' field
    },
  },
});
```

### The Database
The `Database` class is the main entry point to CtroDB. You instantiate it with your schema and a database name. You must call `.connect()` before performing any operations. It is the central hub that manages collections, the adapter, and the event emitter.

```javascript
const db = new Database({ schema: blogSchema, dbName: 'MyBlog' });
await db.connect();
```

### Collections & Models
You interact with your data through `Collection` objects, which you get from the database instance. When you fetch data, you get back `Model` instances. These are "live" objects that hold your record's data and have useful methods like `.update()` and `.delete()`, allowing for an object-oriented way to manage your data.

```javascript
const postsCollection = db.getCollection('posts');

// .create() returns a Model instance
const myPost = await postsCollection.create({ title: 'My First Post' });

// You can call methods directly on the model
await myPost.update({ content: 'This is the updated content.' });
await myPost.delete();
```

### Queries
The `Query` builder provides a clean, chainable API to find your data. Queries are lazily executed, meaning the database is only hit when you call a terminal method like `.fetch()` or `.first()`. This allows you to build up complex queries step-by-step.

```javascript
// Simple equality query
const drafts = await posts.query().where('isPublished', false).fetch();

// Advanced range query
const recentPosts = await posts.query().where('publishedAt', '>', 1672531200000).fetch();
```

### Reactivity with `observe()`
This is the magic of CtroDB. The `.observe()` method runs your query and gives you the results, then automatically re-runs the query and gives you the new results whenever any data that could affect the query is changed. This makes building reactive user interfaces incredibly simple.

```javascript
const postsListElement = document.getElementById('posts-list');

posts.query().observe(allPosts => {
  // This callback runs immediately, and then again on any change.
  // It's perfect for rendering UI with frameworks like React, Vue, or Svelte.
  ui.renderPosts(allPosts);
});
```

## 💡 Advanced Usage

### Relational Queries
Define relations in your schema, and CtroDB will automatically provide convenient getters on your models that return pre-configured queries for the related data.

```javascript
// In your Schema, a comment 'belongs_to' a post:
// ... comments collection
relations: {
  post: { type: 'belongs_to', collection: 'posts', foreignKey: 'postId' }
}

// In your application code:
const comment = await db.getCollection('comments').find(1);
const parentPostQuery = comment.post; // This is a Query object!
const parentPost = await parentPostQuery.first();

console.log(`Comment belongs to post: ${parentPost.title}`);
```

### Complex `OR` Queries
Use the `.orWhere()` method to build complex, compound queries. It accepts a function to prevent ambiguity and allow for clear, nested logic.

```javascript
// Find posts that are featured OR have a rating greater than 4
const postsToShow = await posts.query()
  .where('isFeatured', true)
  .orWhere(q => q.where('rating', '>', 4))
  .fetch();
```

### Debugging
CtroDB has a built-in, level-based logger. To see detailed logs of every operation, set the `logLevel` during database initialization. This is invaluable for development and troubleshooting.

```javascript
import { LogLevel } from 'ctrodb';

const db = new Database({
  // ...
  logLevel: LogLevel.DEBUG, // See everything! From connection to query execution.
});
```

## 🤝 Contributing

Contributions, issues, and feature requests are welcome! Feel free to check the [issues page](https://github.com/ctrotech-tutor/ctrodb/issues). Please read the `CONTRIBUTING.md` file for details on our code of conduct and the process for submitting pull requests.

## ⚖️ License

Copyright © 2025 Ctrotech.
This project is [MIT](https://opensource.org/licenses/MIT) licensed.
