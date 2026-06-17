import { useMutation, useQuery } from "ctrodb/react"
import type { FormEvent } from "react"
import { useState } from "react"

interface Todo {
  text: string
  done: boolean
  createdAt: string
}

export function TodoApp() {
  const todos = useQuery<Todo>("todos", (q) => q.sort({ createdAt: "desc" }))
  const { create, update, delete: remove, loading, error } = useMutation<Todo>("todos")
  const [input, setInput] = useState("")

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    if (!input.trim()) return
    await create({ text: input.trim() })
    setInput("")
  }

  const toggleDone = async (id: string, current: boolean) => {
    await update(id, { done: !current })
  }

  const deleteTodo = async (id: string) => {
    await remove(id)
  }

  const count = todos.length
  const doneCount = todos.filter((t) => t.done).length

  return (
    <div className="section">
      <h2>Todos</h2>
      <p className="stats">{doneCount}/{count} completed</p>

      <form className="todo-form" onSubmit={handleSubmit}>
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="What needs to be done?"
          disabled={loading}
        />
        <button type="submit" disabled={loading || !input.trim()}>
          {loading ? "Adding..." : "Add"}
        </button>
      </form>

      {error && <div className="error">{error}</div>}

      {count === 0
        ? <p className="empty">No todos yet. Add one above!</p>
        : (
          <ul className="todo-list">
            {todos.map((todo) => (
              <li key={todo.id as string} className={`todo-item ${todo.done ? "done" : ""}`}>
                <label>
                  <input
                    type="checkbox"
                    checked={todo.done}
                    onChange={() => toggleDone(todo.id as string, todo.done)}
                  />
                  <span>{todo.text}</span>
                </label>
                <button className="delete-btn" onClick={() => deleteTodo(todo.id as string)}>
                  ✕
                </button>
              </li>
            ))}
          </ul>
        )}
    </div>
  )
}
