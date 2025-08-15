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
- [Installation](#-installation)
- [Quick Start](#-quick-start)
- [Core Concepts](#-core-concepts)
  - [1. The Schema](#1-the-schema)
  - [2. The Database](#2-the-database)
  - [3. Collections & Models](#3-collections--models)
  - [4. Queries](#4-queries)
  - [5. Reactivity with `observe()`](#5-reactivity-with-observe)
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
*   **🪶 Zero Dependencies:** Written in plain, modern JavaScript, making it lightweight, transparent, and secure.
*   **🐛 Built-in Debugging:** A configurable, level-based logger to help you diagnose issues and understand data flow.
*   **🗄️ Schema-Driven:** Define a clear schema for your data to ensure consistency and enable powerful, automated migrations.

## 📦 Installation

Install the package from NPM using your favorite package manager:

```bash
npm install ctrodb
```
```bash
yarn add ctrodb
```
```bash
pnpm add ctrodb
```

## 🚀 Quick Start

Get up and running in 5 minutes.

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
  logLevel: LogLevel.INFO, // Set to DEBUG for more verbosity
});
await db.connect();

// 3. Get a collection and create a record
const posts = db.getCollection('posts');
await posts.create({ title: 'Hello CtroDB!', rating: 5 });

// 4. Query your data
const topPosts = await posts.query()
  .where('rating', '>=', 5)
  .fetch();

console.log(topPosts.title); // "Hello CtroDB!"
```

## 🧠 Core Concepts

### 1. The Schema

The `Schema` is the blueprint for your database. It defines the version, the collections (tables), and the fields, indexes, and relations within them. A well-defined schema is the key to a robust application.

```javascript
const blogSchema = new Schema({
  version: 1, // Increment this to trigger migrations
  collections: {
    posts: {
      fields: { title: 'string', content: 'string' },
      indexes: ['title'], // For fast lookups on the 'title' field
    },
    // ... other collections
  },
});
```

### 2. The Database

The `Database` class is the main entry point to CtroDB. You instantiate it with your schema and a database name. You must call `.connect()` before performing any operations.

```javascript
const db = new Database({ schema: blogSchema, dbName: 'MyBlog' });
await db.connect();
```

### 3. Collections & Models

You interact with your data through `Collection` objects. When you fetch data, you get back `Model` instances, which are "live" objects that hold your data and have useful methods like `.update()` and `.delete()`.

```javascript
const postsCollection = db.getCollection('posts');

// .create() returns a Model instance
const myPost = await postsCollection.create({ title: 'My First Post' });

// You can call methods directly on the model
await myPost.update({ content: 'This is the updated content.' });
await myPost.delete();
```

### 4. Queries

The `Query` builder provides a clean, chainable API to find your data. Queries are lazily executed when you call `.fetch()` or `.first()`.

```javascript
// Simple equality query
const drafts = await posts.query().where('isPublished', false).fetch();

// Advanced range query
const recentPosts = await posts.query().where('publishedAt', '>', 1672531200000).fetch();
```

### 5. Reactivity with `observe()`

This is the magic of CtroDB. The `.observe()` method runs your query and gives you the results, then automatically re-runs the query and gives you the new results whenever any data that could affect the query is changed.

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

Define relations in your schema, and CtroDB will automatically provide convenient getters on your models.

```javascript
// In your Schema:
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

Use the `.orWhere()` method to build complex, compound queries.

```javascript
// Find posts that are featured OR have a rating greater than 4
const postsToShow = await posts.query()
  .where('isFeatured', true)
  .orWhere(q => q.where('rating', '>', 4))
  .fetch();
```

### Debugging

CtroDB has a built-in logger. To see detailed logs of every operation, set the `logLevel` during database initialization.

```javascript
import { LogLevel } from 'ctrodb';

const db = new Database({
  // ...
  logLevel: LogLevel.DEBUG, // See everything!
});
```

## 🤝 Contributing

Contributions, issues, and feature requests are welcome! Feel free to check the [issues page](https://github.com/ctrotech-tutor/ctrodb/issues).

## ⚖️ License

Copyright © 2025 Ctrotech.
This project is [MIT](https://opensource.org/licenses/MIT) licensed.
