-- Base separada para los tests de integracion.
--
-- Los tests truncan tablas entre casos. Hacerlo contra la base de desarrollo
-- borraria datos que uno acaba de crear a mano para inspeccionar una carrera.
CREATE DATABASE whatsapp_lab_test OWNER lab;
