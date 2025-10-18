import './App.css'

import React from 'react'
import { BrowserRouter as Router, Link, Route, Routes } from 'react-router-dom'

import Scoreboard from './Scoreboard'

const Home: React.FC = () => {
  return (
    <div className="app">
      <div className="logo-container">
        <img
          src="/dashboard/assets/images/edge_logo.png"
          alt="Edge Logo"
          className="edge-logo"
        />
        <nav className="nav-links">
          <Link to="/scoreboard" className="nav-link">
            Go to Scoreboard
          </Link>
        </nav>
      </div>
    </div>
  )
}

const App: React.FC = () => {
  return (
    <Router>
      <Routes>
        <Route path="/" element={<Scoreboard />} />
        <Route path="/home" element={<Home />} />
      </Routes>
    </Router>
  )
}

export default App
