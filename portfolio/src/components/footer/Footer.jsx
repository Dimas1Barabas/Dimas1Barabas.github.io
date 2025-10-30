import React from 'react';
import vk from '../../img/icons/vk.svg';
import instagram from '../../img/icons/instagram.svg';
import twitter from '../../img/icons/twitter.svg';
import gitHub from '../../img/icons/gitHub.svg';
import linkedIn from '../../img/icons/linkedIn.svg';
import "./style.css"

const Footer = () => {
  return (
    <footer className="footer">
      <div className="container">
        <div className="footer__wrapper">
          <ul className="social">
            <li className="social__item">
              <a href="#!">
                <img
                  src={vk}
                  alt="Link"/>
              </a>
            </li>
            <li className="social__item">
              <a href="#!">
                <img
                  src={instagram}
                  alt="Link"/>
              </a>
            </li>
            <li className="social__item">
              <a href="#!">
                <img
                  src={twitter}
                  alt="Link"/>
              </a>
            </li>
            <li className="social__item">
              <a href="#!">
                <img
                  src={gitHub}
                  alt="Link"/>
              </a>
            </li>
            <li className="social__item">
              <a href="#!">
                <img
                  src={linkedIn}
                  alt="Link"/>
              </a>
            </li>
          </ul>
          <div className="copyright">
            <p>© 2025 frontend-dev.com</p>
          </div>
        </div>
      </div>
    </footer>
  );
};

export default Footer;