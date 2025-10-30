import React from 'react'
import type { ImageStyle } from 'react-native'
import { Image, Pressable, StyleSheet, Text, View } from 'react-native'
import { BrowserRouter as Router, Link, Route, Routes } from 'react-router-dom'

import Dashboard from './Dashboard'
import Scoreboard from './Scoreboard'

const Home: React.FC = () => {
  return (
    <View style={styles.app}>
      <View style={styles.logoContainer}>
        <Image
          source={{ uri: '/assets/images/edge_logo.png' }}
          style={styles.edgeLogo as ImageStyle}
          resizeMode="contain"
        />
        <View style={styles.navLinks}>
          <Link to="/scoreboard" style={{ textDecoration: 'none' }}>
            <Pressable style={styles.navLink}>
              <Text style={styles.navLinkText}>Go to Scoreboard</Text>
            </Pressable>
          </Link>
        </View>
      </View>
    </View>
  )
}

const App: React.FC = () => {
  return (
    <Router>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/scoreboard" element={<Scoreboard />} />
        <Route path="/dashboard" element={<Dashboard />} />
      </Routes>
    </Router>
  )
}

const styles = StyleSheet.create({
  app: {
    flex: 1,
    minHeight: 600,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#667eea'
  },
  logoContainer: {
    alignItems: 'center',
    padding: 32,
    backgroundColor: 'white',
    borderRadius: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 20 },
    shadowOpacity: 0.1,
    shadowRadius: 25,
    elevation: 10
  },
  edgeLogo: {
    height: 64,
    width: 200
  },
  navLinks: {
    marginTop: 24
  },
  navLink: {
    paddingVertical: 12,
    paddingHorizontal: 24,
    borderRadius: 8,
    backgroundColor: '#667eea'
  },
  navLinkText: {
    color: 'white',
    fontWeight: '600'
  }
})

export default App
