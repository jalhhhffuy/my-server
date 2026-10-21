FROM valkey/valkey:8.1.10
USER root
COPY storage/valkey.conf /etc/valkey/game-store.conf
COPY storage/start.sh /usr/local/bin/start-game-store
RUN chmod 755 /usr/local/bin/start-game-store
EXPOSE 6379
ENTRYPOINT ["tini", "--", "/usr/local/bin/start-game-store"]
