cmake_minimum_required(VERSION 3.22.1)
project(socketqueue C)

# One call: how many bytes a TCP socket's kernel send queue holds. See SocketQueue.kt.
add_library(socketqueue SHARED socket_queue.c)
