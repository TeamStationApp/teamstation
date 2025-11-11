import React from 'react'
import { BrowserRouter as Router, Route, Routes } from 'react-router-dom'

import Dashboard from './Dashboard'
import EventLinks from './EventLinks'
import EventRegistration from './EventRegistration'
import Scoreboard from './Scoreboard'
import { ThemeProvider } from './ThemeContext'

const App: React.FC = () => {
  return (
    <ThemeProvider>
      <Router>
        <Routes>
          <Route path="/" element={<EventRegistration />} />
          <Route path="/links/:eventId" element={<EventLinks />} />
          <Route path="/dashboard/:eventId" element={<Dashboard />} />
          <Route path="/scoreboard/:eventId" element={<Scoreboard />} />
        </Routes>
      </Router>
    </ThemeProvider>
  )
}

export default App
