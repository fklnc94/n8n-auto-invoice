FROM node:20-slim

WORKDIR /app

# Unified package.json — hem CloakBrowser hem Playwright bağımlılıkları
COPY package.json ./

# Tüm bağımlılıkları kur
RUN npm install

# CloakBrowser'ın stealth Chromium binary'sini indir
RUN npx cloakbrowser install

# Fallback akışı için Playwright Chromium tarayıcısını + sistem bağımlılıklarını kur
RUN npx playwright install --with-deps chromium

# Saat dilimi
ENV TZ=Europe/Istanbul

CMD ["tail", "-f", "/dev/null"]
