import { useMutation, useQuery } from "ctrodb/react"
import type { FormEvent } from "react"
import { useState } from "react"

interface Article {
  title: string
  body: string
  createdAt: string
}

export function SearchDemo() {
  const [search, setSearch] = useState("")
  const articles = useQuery<Article>("articles", (q) => {
    let query = q.sort({ createdAt: "desc" })
    if (search.trim()) {
      query = query.search("title", search.trim())
    }
    return query
  }, [search])
  const { create, loading, error } = useMutation<Article>("articles")
  const [title, setTitle] = useState("")
  const [body, setBody] = useState("")

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    if (!title.trim() || !body.trim()) return
    await create({ title: title.trim(), body: body.trim() })
    setTitle("")
    setBody("")
  }

  return (
    <div className="section">
      <h2>Full-Text Search</h2>
      <p className="hint">Articles are indexed with the FTS plugin. Search indexes update automatically on create/update/delete.</p>

      <form className="todo-form" onSubmit={handleSubmit}>
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Article title"
          disabled={loading}
        />
        <input
          type="text"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Article body"
          disabled={loading}
        />
        <button type="submit" disabled={loading || !title.trim() || !body.trim()}>
          {loading ? "Adding..." : "Add Article"}
        </button>
      </form>

      <div className="search-bar">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search articles by title..."
        />
        {search && <button className="clear-btn" onClick={() => setSearch("")}>✕</button>}
      </div>

      {error && <div className="error">{error}</div>}

      {articles.length === 0
        ? <p className="empty">{search ? "No articles match your search." : "No articles yet. Add one above!"}</p>
        : (
          <ul className="article-list">
            {articles.map((a) => (
              <li key={a.id as string} className="article-item">
                <strong>{a.title}</strong>
                <p>{a.body}</p>
              </li>
            ))}
          </ul>
        )}
    </div>
  )
}
