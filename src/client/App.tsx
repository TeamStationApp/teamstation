import './App.css'

import React from 'react'
import { BrowserRouter as Router, Link, Route, Routes } from 'react-router-dom'

import Dashboard from './Dashboard'
import Scoreboard from './Scoreboard'

const Home: React.FC = () => {
  return (
    <div className="app">
      <div className="logo-container">
        <img
          src="/scoreboard/assets/images/edge_logo.png"
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
        <Route path="/home" element={<Home />} />
        <Route path="/scoreboard" element={<Scoreboard />} />
        <Route path="/dashboard" element={<Dashboard />} />
      </Routes>
    </Router>
  )
}

export default App
