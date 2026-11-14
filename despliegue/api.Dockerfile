ARG FREERADIUS_TAG=latest-3.2

FROM golang:1.25-bookworm AS compilacion
WORKDIR /src
COPY api/go.mod api/go.sum ./
RUN go mod download
COPY api/ ./
RUN go vet ./... && go test ./... && CGO_ENABLED=0 go build -trimpath -o /radiuscontrol .

# La API lleva el binario de FreeRADIUS solo para validar la configuración
# antes de activarla. No atiende tráfico RADIUS.
FROM freeradius/freeradius-server:${FREERADIUS_TAG}
COPY despliegue/freeradius/rc_registro.mod despliegue/freeradius/rc_registro.policy despliegue/freeradius/preparar.sh /tmp/rc/
RUN sh /tmp/rc/preparar.sh
COPY --from=compilacion /radiuscontrol /usr/local/bin/radiuscontrol
ENTRYPOINT ["/usr/local/bin/radiuscontrol"]
CMD []
