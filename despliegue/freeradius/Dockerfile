ARG FREERADIUS_TAG=latest-3.2
FROM freeradius/freeradius-server:${FREERADIUS_TAG}

COPY despliegue/freeradius/arranque.sh /arranque.sh
RUN chmod 0755 /arranque.sh

ENTRYPOINT ["/arranque.sh"]
CMD []
