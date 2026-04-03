FROM ollama/ollama:latest

RUN ollama serve & \
    OLLAMA_PID=$! && \
    sleep 5 && \
    ollama pull llama3.2:1b && \
    kill $OLLAMA_PID && \
    wait $OLLAMA_PID 2>/dev/null || true

EXPOSE 11434
