FROM mcr.microsoft.com/playwright:v1.58.2-noble
RUN apt-get update && apt-get install -y --no-install-recommends python3-pyatspi dbus-x11 xdotool openbox imagemagick espeak-ng && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/runner
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
RUN espeak-ng -v en-us -w /opt/runner/interviewer.wav "Please describe a technical challenge in project Cedar and explain how you solved it." && espeak-ng -v en-us -w /opt/runner/candidate.wav "In project Cedar, I improved the database queries and reduced response time by thirty percent. I measured the result before and after the change."
USER pwuser
ENV ACCESSIBILITY_ENABLED=1 HOME=/tmp/home NO_AT_BRIDGE=0 GTK_MODULES=gail:atk-bridge RUNNER_ISOLATED=1
EXPOSE 9090
CMD ["dbus-run-session", "--", "xvfb-run", "-a", "--server-args=-screen 0 1366x1000x24", "node", "server.mjs"]
