# Registro de autenticaciones de RadiusControl: una línea por login, con los
# campos separados por tabulador. Los valores que escribe el cliente van con
# codificación de URL para que no puedan romper el formato.
linelog rc_registro {
	filename = /registro/auth.log
	permissions = 0640
	escape_filenames = no
	format = "%l\t%{control:Tmp-String-1}\t%{urlquote:%{User-Name}}\t%{%{Packet-Src-IP-Address}:-%{Packet-Src-IPv6-Address}}\t%{urlquote:%{client:shortname}}\t%{urlquote:%{NAS-Identifier}}\t%{%{NAS-IP-Address}:-%{NAS-IPv6-Address}}\t%{urlquote:%{Calling-Station-Id}}\t%{control:Tmp-String-0}\t%{urlquote:%{reply:Mikrotik-Group}}\t%{urlquote:%{Module-Failure-Message}}"
}
