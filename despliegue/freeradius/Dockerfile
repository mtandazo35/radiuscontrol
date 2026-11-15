ARG FREERADIUS_TAG=latest-3.2
FROM freeradius/freeradius-server:${FREERADIUS_TAG}

COPY despliegue/freeradius/rc_registro.mod despliegue/freeradius/rc_registro.policy despliegue/freeradius/rc_accesos.policy despliegue/freeradius/preparar.sh /tmp/rc/
RUN sh /tmp/rc/preparar.sh

COPY despliegue/freeradius/arranque.sh /arranque.sh
RUN chmod 0755 /arranque.sh

ENTRYPOINT ["/arranque.sh"]
CMD []
