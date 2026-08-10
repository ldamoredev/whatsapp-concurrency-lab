# Design

<!-- impeccable:design-schema 1 -->

Sistema visual del panel de laboratorio. Registra el mundo **incumbente**, establecido en
S6 y preservado en el rediseño: no fue reemplazado, fue extendido con un eje nuevo.

## Mundo

Instrumento de medición, no producto de consumo. La referencia es el aparato de laboratorio
y la hoja de datos: densidad alta, cero ornamento, y **color exclusivamente como significado
de estado**. Si un elemento tiene color, es porque el color dice algo que el texto también
dice.

**Escena de uso que fija claro/oscuro:** una persona sola frente a la pantalla, de noche o
en una oficina con luz artificial, alternando entre el panel y una terminal. Fondo oscuro
por continuidad con la terminal que tiene al lado, con modo claro completo para quien
proyecte en una sala iluminada.

## Eje nuevo del rediseño: la comparación

La decisión estructural que define el panel: **cada escenario corre dos veces**, con la
misma entrada, contra la misma base.

- **Columna izquierda — sin protección.** El camino ingenuo, el que uno escribiría sin
  pensar en concurrencia. Rojo apagado.
- **Columna derecha — con protección.** El camino real del sistema. Verde.

Las dos columnas tienen **el mismo peso visual**. Ninguna es el "antes feo" y la otra el
"después lindo": las dos son código legítimo, y la diferencia es una línea de SQL. El
contraste entre ambas ES la página; todo lo demás la sirve.

## Color

Estrategia: **restringida** — neutros más el color reservado a estado. El visitante vino a
entender, no a ser persuadido.

| Rol | Oscuro | Claro | Significa |
|---|---|---|---|
| `--ok` | `#4ade80` | `#137236` | correcto, protegido, publicado |
| `--bad` | `#f87171` | `#b91c1c` | roto, duplicado, sin protección |
| `--warn` | `#fbbf24` | `#b45309` | esperando, bufferizado, en curso |
| `--info` | `#60a5fa` | `#1d4ed8` | leído, dato neutro |
| `--accent` | `#a78bfa` | `#6d28d9` | identidad de réplica, marcadores de sección |

**Regla dura:** el estado nunca se comunica sólo por color. Siempre hay una etiqueta de
texto, un símbolo o una posición que lo repite. Un daltónico tiene que poder usar el panel.

Los fondos son cuatro escalones de gris: `--bg` (página), `--panel` (superficie),
`--panel-2` (cabeceras y superficies anidadas), `--line` (separadores).

## Tipografía

**Una sola familia mono** en todo el panel. No es disfraz de "técnico": todo lo que el panel
muestra son datos, identificadores, secuencias y código. Un texto explicativo al lado de una
tabla de números se lee mejor en la misma métrica.

```
--mono: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace
```

Escala: 9.5px (etiquetas de columna) · 11px (secundario) · 13px (base) · 15–18px (títulos de
sección) · 28–40px (los números que son la evidencia).

Los números de resultado son lo único que crece. Cuando un escenario deja `1 mensaje` de un
lado y `43 mensajes` del otro, esos dos números son el argumento entero y se dimensionan
como tal.

## Composición

- Grilla de contenido máx. `1500px`, con la comparación siempre a dos columnas de igual peso
  separadas por una regla vertical de 1px.
- Medida de lectura del texto explicativo: 65–75ch. La prosa nunca ocupa el ancho de una
  tabla.
- Más espacio arriba de un encabezado que abajo.
- Radio `6px`, uniforme. Sin sombras decorativas: la separación se hace con línea y fondo.

## Profundidad de lectura

Un dial persistente con dos posiciones — **breve** y **detallado** — cambia la densidad del
texto explicativo sin mover el esqueleto de la página. Los encabezados y los resultados no
se mueven al cambiar de profundidad; sólo crece o se contrae la prosa debajo.

Existe porque el panel sirve a dos situaciones (aprender solo, mostrar a alguien) y una sola
densidad falla en una de las dos.

## Formularios

El banco de pruebas es la única superficie con entrada de datos. Reglas:

- Cada campo lleva una **pista de qué provoca cambiarlo**, no una descripción de qué es.
  «repetila para reintentar · cambiala para que sea un pedido nuevo» enseña; «la clave de
  idempotencia» no.
- El request se previsualiza **tal como sale por la red**, con el valor editado resaltado.
- Lo que el servidor deriva y no viaja en el request (`route`, `fingerprint`, la cadena
  canónica) va en un bloque aparte, rotulado como tal.
- Todo resultado explica **cuál regla actuó**, no sólo el status: el código HTTP por sí solo
  no distingue si decidió la key o el fingerprint.

## Motion

Un solo momento autorizado: cuando llega el resultado de una comparación, los números
cuentan hacia arriba y la columna que corresponde toma su color de estado. Nada más se
mueve. Sin animaciones de entrada por sección, sin efectos de hover más allá del cambio de
borde.

`prefers-reduced-motion` desactiva el conteo y muestra el valor final directamente.

## Prohibiciones

- **Tarjetas iguales de ícono + título + texto como estructura de página.** Es el andamio
  perezoso; la estructura acá es la comparación.
- **Gradientes en texto.** El énfasis es peso o tamaño.
- **Sparklines, anillos de progreso y rectángulos con sombra** ocupando el lugar del dato.
- **Eyebrows en mayúsculas sobre cada sección.** Las etiquetas de invariante (I1, I4) son un
  sistema con significado; una etiqueta decorativa sobre cada bloque no.
- **Verde permanente.** Un panel que siempre está en verde no demuestra nada. El rojo de la
  columna sin protección tiene que verse tanto como el verde de la otra.

## Accesibilidad

- Contraste de cuerpo ≥ 4.5:1 y de texto grande ≥ 3:1, **medido** en claro y oscuro contra
  los tres fondos (`--bg`, `--panel`, `--panel-2`), no estimado a ojo. El peor caso manda:
  `--text-faint` es 4.71 en oscuro y 5.06 en claro; `--ok` es 9.36 y 5.28.
- Foco de teclado visible en todo control.
- Las dos columnas de la comparación se apilan en pantallas angostas, sin perder el orden
  sin-protección → con-protección.
- Tablas anchas hacen scroll dentro de su contenedor; la página nunca scrollea en
  horizontal.
