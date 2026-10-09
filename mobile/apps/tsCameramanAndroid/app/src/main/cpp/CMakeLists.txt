cmake_minimum_required(VERSION 3.22.1)
project(socketqueue C)

# How many bytes a TCP socket's kernel send queue holds (SocketQueue.kt), and the crash that
# proves native crash reporting works (SentryTest.kt).
add_library(socketqueue SHARED socket_queue.c sentry_test.c)
